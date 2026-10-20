#pragma once
#include <windows.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <fstream>
#include <filesystem>
#include <stdexcept>
#include <vector>
#include <string>

inline std::string Utf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int count=WideCharToMultiByte(CP_UTF8,0,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
    std::string result(count,'\0');
    WideCharToMultiByte(CP_UTF8,0,text.data(),static_cast<int>(text.size()),result.data(),count,nullptr,nullptr);
    return result;
}
inline std::wstring Wide(const std::string& text) {
    if (text.empty()) return {};
    const int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0);
    if(!count) throw std::runtime_error("Invalid UTF-8");
    std::wstring result(count,L'\0');
    MultiByteToWideChar(CP_UTF8,0,text.data(),static_cast<int>(text.size()),result.data(),count);
    return result;
}
inline void HttpCheck(BOOL success,const char* action) {
    if(!success) throw std::runtime_error(std::string(action)+" (Windows error "+std::to_string(GetLastError())+")");
}
struct NativeUrl {
    std::wstring host;
    INTERNET_PORT port{};
    static NativeUrl Parse(const std::wstring& url) {
        URL_COMPONENTS parts{};parts.dwStructSize=sizeof(parts);
        parts.dwHostNameLength=parts.dwUrlPathLength=parts.dwUserNameLength=parts.dwPasswordLength=parts.dwExtraInfoLength=DWORD(-1);
        HttpCheck(WinHttpCrackUrl(url.c_str(),0,0,&parts),"Invalid host URL");
        const std::wstring path(parts.lpszUrlPath ? parts.lpszUrlPath : L"",parts.dwUrlPathLength);
        const std::wstring query(parts.lpszExtraInfo ? parts.lpszExtraInfo : L"",parts.dwExtraInfoLength);
        if(parts.nScheme!=INTERNET_SCHEME_HTTPS || !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength ||
           (!path.empty() && path!=L"/") || (!query.empty() && query!=L"?client=pc"))
            throw std::runtime_error("Use the PC service HTTPS homepage URL");
        return {std::wstring(parts.lpszHostName,parts.dwHostNameLength),parts.nPort};
    }
};

// Explicit app-scoped trust. Never install a root or accept an arbitrary server certificate.
inline void VerifyPrivateCA(HINTERNET request,const std::wstring& host,const std::wstring& caPath) {
    std::ifstream file(std::filesystem::path(caPath),std::ios::binary);
    std::string bytes((std::istreambuf_iterator<char>(file)),{});
    if(bytes.empty() || bytes.size()>128*1024) throw std::runtime_error("Cannot read CA certificate");
    std::vector<BYTE> der;
    if(bytes.find("-----BEGIN CERTIFICATE-----")!=std::string::npos) {
        DWORD size=0;
        HttpCheck(CryptStringToBinaryA(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64HEADER,nullptr,&size,nullptr,nullptr),"Read CA PEM");
        der.resize(size);
        HttpCheck(CryptStringToBinaryA(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64HEADER,der.data(),&size,nullptr,nullptr),"Decode CA PEM");
    } else der.assign(bytes.begin(),bytes.end());
    HCERTSTORE store=CertOpenStore(CERT_STORE_PROV_MEMORY,0,0,CERT_STORE_CREATE_NEW_FLAG,nullptr);
    if(!store) throw std::runtime_error("Cannot create private trust store");
    PCCERT_CONTEXT certificate=nullptr;
    HCERTCHAINENGINE engine=nullptr;
    PCCERT_CHAIN_CONTEXT chain=nullptr;
    try {
        HttpCheck(CertAddEncodedCertificateToStore(store,X509_ASN_ENCODING,der.data(),static_cast<DWORD>(der.size()),CERT_STORE_ADD_NEW,nullptr),"Read CA certificate");
        CERT_CHAIN_ENGINE_CONFIG config{};config.cbSize=sizeof(config);config.hExclusiveRoot=store;
        HttpCheck(CertCreateCertificateChainEngine(&config,&engine),"Create private chain engine");
        DWORD size=sizeof(certificate);
        HttpCheck(WinHttpQueryOption(request,WINHTTP_OPTION_SERVER_CERT_CONTEXT,&certificate,&size),"Read server certificate");
        CERT_CHAIN_PARA parameters{};parameters.cbSize=sizeof(parameters);
        HttpCheck(CertGetCertificateChain(engine,certificate,nullptr,certificate->hCertStore,&parameters,CERT_CHAIN_CACHE_ONLY_URL_RETRIEVAL,nullptr,&chain),"Validate certificate chain");
        SSL_EXTRA_CERT_CHAIN_POLICY_PARA ssl{};ssl.cbSize=sizeof(ssl);ssl.dwAuthType=AUTHTYPE_SERVER;ssl.pwszServerName=const_cast<wchar_t*>(host.c_str());
        CERT_CHAIN_POLICY_PARA policy{};policy.cbSize=sizeof(policy);policy.pvExtraPolicyPara=&ssl;
        CERT_CHAIN_POLICY_STATUS status{};status.cbSize=sizeof(status);
        HttpCheck(CertVerifyCertificateChainPolicy(CERT_CHAIN_POLICY_SSL,chain,&policy,&status),"Validate server identity");
        if(status.dwError) throw std::runtime_error("Certificate identity or private CA verification failed ("+std::to_string(status.dwError)+")");
    } catch(...) {
        if(chain) CertFreeCertificateChain(chain);
        if(certificate) CertFreeCertificateContext(certificate);
        if(engine) CertFreeCertificateChainEngine(engine);
        CertCloseStore(store,0);throw;
    }
    if(chain) CertFreeCertificateChain(chain);
    if(certificate) CertFreeCertificateContext(certificate);
    if(engine) CertFreeCertificateChainEngine(engine);
    CertCloseStore(store,0);
}
