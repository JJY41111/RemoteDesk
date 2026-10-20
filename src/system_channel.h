#pragma once
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <cstdio>
#include <string>
#include <stdexcept>
#include <iostream>
#include <streambuf>

namespace remotedesk {
inline bool PipeTransfer(HANDLE pipe, void* data, DWORD size, DWORD& count, bool write) {
    OVERLAPPED operation{};operation.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    if(!operation.hEvent)return false;
    BOOL ok=write?WriteFile(pipe,data,size,&count,&operation):ReadFile(pipe,data,size,&count,&operation);
    if(!ok&&GetLastError()==ERROR_IO_PENDING)ok=GetOverlappedResult(pipe,&operation,&count,TRUE);
    const DWORD error=ok?0:GetLastError();CloseHandle(operation.hEvent);SetLastError(error);
    return ok!=FALSE;
}
class PipeInputBuffer:public std::streambuf {
    HANDLE pipe_;char bytes_[4096];
protected:
    int_type underflow() override {
        DWORD count{};if(!PipeTransfer(pipe_,bytes_,sizeof(bytes_),count,false)||!count)return traits_type::eof();
        setg(bytes_,bytes_,bytes_+count);return traits_type::to_int_type(*gptr());
    }
public: explicit PipeInputBuffer(HANDLE pipe):pipe_(pipe){}
};
class PipeOutputBuffer:public std::streambuf {
    HANDLE pipe_;
protected:
    std::streamsize xsputn(const char* data,std::streamsize size) override {
        std::streamsize written=0;DWORD count{};
        while(written<size){
            if(!PipeTransfer(pipe_,const_cast<char*>(data+written),static_cast<DWORD>(size-written),count,true)||!count)break;
            written+=count;
        }
        return written;
    }
    int_type overflow(int_type value) override {
        if(traits_type::eq_int_type(value,traits_type::eof()))return traits_type::not_eof(value);
        const char byte=traits_type::to_char_type(value);return xsputn(&byte,1)==1?value:traits_type::eof();
    }
    int sync() override{return 0;}
public: explicit PipeOutputBuffer(HANDLE pipe):pipe_(pipe){}
};
inline HANDLE systemInputPipe=nullptr;
inline bool ReadHelperInput(HANDLE input,void* bytes,DWORD size,DWORD& count){
    return systemInputPipe?PipeTransfer(input,bytes,size,count,false):ReadFile(input,bytes,size,&count,nullptr)!=FALSE;
}
inline bool IsSystemToken(HANDLE token) {
    BYTE data[512]{}; DWORD size = 0;
    if (!GetTokenInformation(token, TokenUser, data, sizeof(data), &size)) return false;
    return IsWellKnownSid(reinterpret_cast<TOKEN_USER*>(data)->User.Sid, WinLocalSystemSid);
}
inline bool IsSystemProcess() {
    HANDLE token{};
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    const bool result = IsSystemToken(token); CloseHandle(token); return result;
}
// Internal service channel, never an arbitrary file or network endpoint.
inline void ConnectSystemChannel(const std::wstring& name) {
    const std::wstring prefix = L"\\\\.\\pipe\\RemoteDesk.Agent.";
    if (!IsSystemProcess() || name.rfind(prefix, 0) != 0 ||
        name.size() > 100 || name.find_first_not_of(L"0123456789abcdefABCDEF-", prefix.size()) != std::wstring::npos)
        throw std::runtime_error("Invalid system helper channel");
    HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
    if (pipe == INVALID_HANDLE_VALUE) throw std::runtime_error("System helper channel unavailable");
    ULONG pid{}; HANDLE process{}, token{};
    bool trusted = GetNamedPipeServerProcessId(pipe, &pid) != FALSE;
    if (trusted) process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    trusted = process && OpenProcessToken(process, TOKEN_QUERY, &token) && IsSystemToken(token);
    if (token) CloseHandle(token); if (process) CloseHandle(process);
    if (!trusted) { CloseHandle(pipe); throw std::runtime_error("Untrusted system channel server"); }
    // Keep independent overlapped read/write operations on the same duplex
    // pipe. Synchronous handles serialize them and can deadlock READY/state.
    // Process-lifetime stream buffers outlive the standard iostream shutdown.
    static auto* input=new PipeInputBuffer(pipe);static auto* output=new PipeOutputBuffer(pipe);
    systemInputPipe=pipe;
    SetStdHandle(STD_INPUT_HANDLE,pipe);SetStdHandle(STD_OUTPUT_HANDLE,pipe);SetStdHandle(STD_ERROR_HANDLE,pipe);
    std::cin.rdbuf(input);std::cout.rdbuf(output);std::cerr.rdbuf(output);
    std::cin.clear(); std::cout.clear(); std::cerr.clear();
}
// Input helper has no HWND/hooks, so it can follow the active desktop. Ordinary
// helpers never gain this ability: it is enabled only for the SYSTEM channel.
class InputDesktop {
    HDESK owned_{};
    HDESK original_=GetThreadDesktop(GetCurrentThreadId());
public:
    ~InputDesktop() {
        if(owned_ && SetThreadDesktop(original_))CloseDesktop(owned_);
    }
    InputDesktop()=default;
    InputDesktop(const InputDesktop&)=delete;
    InputDesktop& operator=(const InputDesktop&)=delete;
    static void ReportFailure(const char* stage) {
        const DWORD error=GetLastError();
        wchar_t station[128]{},desktop[128]{};DWORD needed{},session{};
        GetUserObjectInformationW(GetProcessWindowStation(),UOI_NAME,station,sizeof(station),&needed);
        GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()),UOI_NAME,desktop,sizeof(desktop),&needed);
        ProcessIdToSessionId(GetCurrentProcessId(),&session);
        std::cerr<<"SYSTEM_DESKTOP_FAILURE stage="<<stage<<" error="<<error<<" session="<<session
                 <<" station=";
        for(const wchar_t* p=station;*p;++p)std::cerr<<(*p<128?static_cast<char>(*p):'?');
        std::cerr<<" desktop=";
        for(const wchar_t* p=desktop;*p;++p)std::cerr<<(*p<128?static_cast<char>(*p):'?');
        std::cerr<<'\n'<<std::flush;
        SetLastError(error);
    }
    bool Follow() {
        // This handle governs subsequent input access. A reduced object-read /
        // create-window mask omits desktop input rights. The SYSTEM helper uses
        // the same GENERIC_ALL request as Microsoft's desktop-duplication sample;
        // this does not alter the desktop ACL or elevate an ordinary caller.
        HDESK next = OpenInputDesktop(0, FALSE, GENERIC_ALL);
        if (!next) { ReportFailure("OpenInputDesktop"); return false; }
        wchar_t name[128]{}, current[128]{}; DWORD needed{};
        if (!GetUserObjectInformationW(next, UOI_NAME, name, sizeof(name), &needed) ||
            !GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME,
                                  current, sizeof(current), &needed)) {
            const DWORD error=GetLastError();CloseDesktop(next);SetLastError(error);
            ReportFailure("GetDesktopName");return false;
        }
        if (wcscmp(name, current) == 0) { CloseDesktop(next); return true; }
        if (!SetThreadDesktop(next)) {
            const DWORD error=GetLastError();CloseDesktop(next);SetLastError(error);
            ReportFailure("SetThreadDesktop");return false;
        }
        if (owned_) CloseDesktop(owned_);
        owned_ = next; return true;
    }
};
}
