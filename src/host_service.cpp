#include <windows.h>
#include <sddl.h>
#include <wtsapi32.h>
#include <userenv.h>
#include <objbase.h>
#include <array>
#include <atomic>
#include <iostream>
#include <string>
#include <thread>
#include <vector>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <algorithm>
#include "system_channel.h"

namespace {
constexpr wchar_t serviceName[] = L"RemoteDeskHost";
constexpr wchar_t pipeName[] = L"\\\\.\\pipe\\RemoteDesk.Host.v1";
constexpr DWORD pipeAccess = (FILE_GENERIC_READ | FILE_GENERIC_WRITE) & ~FILE_CREATE_PIPE_INSTANCE;
struct Handle {
    HANDLE h{};
    Handle() = default; explicit Handle(HANDLE value):h(value){}
    ~Handle(){ if(h && h!=INVALID_HANDLE_VALUE) CloseHandle(h); }
    Handle(const Handle&)=delete; Handle& operator=(const Handle&)=delete;
};
struct Request {
    DWORD magic=0x52444831, kind=0, adapter=0, output=0, port=0, mode=0, flags=0, profile=0;
};
static_assert(sizeof(Request)==32);
bool Valid(const Request& r) {
    return r.magic==0x52444831 && r.kind<=2 && r.adapter<=9 && r.output<=9 &&
        r.mode<=3 && r.flags<=15 && r.profile<=1 &&
        (r.kind!=2 || (r.port>=1024 && r.port<=65535));
}
bool ReadExact(HANDLE h, void* bytes, DWORD size) {
    DWORD count{}; auto p=static_cast<char*>(bytes);
    while(size){ if(!remotedesk::PipeTransfer(h,p,size,count,false)||!count)return false; p+=count;size-=count; }
    return true;
}
bool WriteAll(HANDLE h,const void* bytes,DWORD size,bool async=true){
    DWORD count{}; auto p=static_cast<const char*>(bytes);
    while(size){if(!(async?remotedesk::PipeTransfer(h,const_cast<char*>(p),size,count,true):WriteFile(h,p,size,&count,nullptr))||!count)return false;p+=count;size-=count;}
    return true;
}
void Relay(HANDLE from,HANDLE to,bool asyncRead=true,bool asyncWrite=true){ char bytes[4096];DWORD count{};
    while((asyncRead?remotedesk::PipeTransfer(from,bytes,sizeof(bytes),count,false):ReadFile(from,bytes,sizeof(bytes),&count,nullptr))&&count)
        if(!WriteAll(to,bytes,count,asyncWrite))break;
}
HANDLE stopEvent{}; SERVICE_STATUS_HANDLE statusHandle{}; std::wstring ownerSid,root,dataRoot;
std::atomic<unsigned> workers{};
std::mutex activeMutex;
std::vector<HANDLE> activePipes,activeJobs;
struct Registered {
    std::vector<HANDLE>& list;HANDLE handle;
    Registered(std::vector<HANDLE>& items,HANDLE value):list(items),handle(value){
        std::lock_guard guard(activeMutex);list.push_back(handle);
    }
    ~Registered(){std::lock_guard guard(activeMutex);std::erase(list,handle);}
};
std::mutex logMutex;
void Trace(const char* message,DWORD error=0){
    std::lock_guard guard(logMutex);
    std::ofstream stream(std::filesystem::path(dataRoot)/L"service.log",std::ios::app);
    stream<<GetTickCount64()<<" "<<message<<" error="<<error<<"\n";
}
void Status(DWORD state){ SERVICE_STATUS s{};s.dwServiceType=SERVICE_WIN32_OWN_PROCESS;
    s.dwCurrentState=state;s.dwControlsAccepted=state==SERVICE_RUNNING?SERVICE_ACCEPT_STOP:0;
    s.dwWaitHint=state==SERVICE_STOP_PENDING?5000:0;SetServiceStatus(statusHandle,&s); }
bool EnablePrivilege(const wchar_t* name){
    Handle token; if(!OpenProcessToken(GetCurrentProcess(),TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY,&token.h))return false;
    TOKEN_PRIVILEGES privileges{};privileges.PrivilegeCount=1;
    if(!LookupPrivilegeValueW(nullptr,name,&privileges.Privileges[0].Luid))return false;
    privileges.Privileges[0].Attributes=SE_PRIVILEGE_ENABLED;SetLastError(0);
    return AdjustTokenPrivileges(token.h,FALSE,&privileges,0,nullptr,nullptr)&&GetLastError()==0;
}
bool Authorized(HANDLE pipe,DWORD& session){
    if(!ImpersonateNamedPipeClient(pipe))return false;
    Handle token;bool ok=OpenThreadToken(GetCurrentThread(),TOKEN_QUERY,TRUE,&token.h)!=FALSE;
    BYTE storage[1024]{};DWORD size{};LPWSTR sid{};
    if(ok)ok=GetTokenInformation(token.h,TokenUser,storage,sizeof(storage),&size)!=FALSE;
    if(ok)ok=ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(storage)->User.Sid,&sid)!=FALSE;
    if(ok)ok=ownerSid==sid;
    if(sid)LocalFree(sid);
    if(ok)ok=GetTokenInformation(token.h,TokenSessionId,&session,sizeof(session),&size)!=FALSE;
    RevertToSelf();
    return ok && session!=0 && session==WTSGetActiveConsoleSessionId();
}
std::wstring Arguments(const Request& r){
    const wchar_t* mode[]={L"--network-1080-60-live",L"--network-native-60-live",L"--network-60-live",L"--network-1080-30-live"};
    std::wstring a=r.kind==2?std::wstring(mode[r.mode])+L" --tcp-port="+std::to_wstring(r.port)+L" ":L"";
    a+=L"--display="+std::to_wstring(r.adapter)+L":"+std::to_wstring(r.output);
    if(r.kind==2){
        if(r.flags&1)a+=L" --wan-video";
        if(r.flags&2)a+=L" --wan-video-mobile";
        if(r.flags&4)a+=L" --recovery-keyframes --adaptive-recovery";
        if(r.flags&8)a+=L" --cpu-conversion";
    }
    return a;
}
void Serve(HANDLE raw){
    Handle outer(raw); ++workers;
    struct Count{~Count(){--workers;}}count;
    Registered publicPipe(activePipes,outer.h);
    Request request{};DWORD session{};
    if(!ReadExact(outer.h,&request,sizeof(request))||!Valid(request)||!Authorized(outer.h,session)){
        Trace("request rejected",GetLastError());return;}
    if(request.kind==0){const char ready[]="HOST_OK\n";WriteAll(outer.h,ready,8);return;}
    // Only these two immutable, administrator-installed executables can run.
    const std::wstring exe=root+(request.kind==1?L"\\remote_desk_input.exe":L"\\remote_desk.exe");
    GUID guid{}; if(FAILED(CoCreateGuid(&guid)))return;wchar_t id[40]{};StringFromGUID2(guid,id,40);
    std::wstring identifier=id;identifier=identifier.substr(1,36);
    const std::wstring innerName=L"\\\\.\\pipe\\RemoteDesk.Agent."+identifier;
    PSECURITY_DESCRIPTOR descriptor{};
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;SY)",SDDL_REVISION_1,&descriptor,nullptr))return;
    SECURITY_ATTRIBUTES attributes{sizeof(attributes),descriptor,FALSE};
    Handle inner(CreateNamedPipeW(innerName.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE|FILE_FLAG_OVERLAPPED,
        PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,65536,65536,0,&attributes));
    LocalFree(descriptor);if(inner.h==INVALID_HANDLE_VALUE)return;
    Handle token,primary;
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_DUPLICATE|TOKEN_QUERY|TOKEN_ASSIGN_PRIMARY,&token.h)||
       !DuplicateTokenEx(token.h,TOKEN_ALL_ACCESS,nullptr,SecurityImpersonation,TokenPrimary,&primary.h)||
       !SetTokenInformation(primary.h,TokenSessionId,&session,sizeof(session))){Trace("session token failed",GetLastError());return;}
    Handle job(CreateJobObjectW(nullptr,nullptr));
    Registered activeJob(activeJobs,job.h);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit=1;
    if(!job.h||!SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))return;
    std::wstring command=L"\""+exe+L"\" "+Arguments(request)+L" --system-channel="+innerName;
    const std::wstring working=dataRoot+L"\\capture-"+std::to_wstring(request.profile);
    CreateDirectoryW(working.c_str(),nullptr);
    STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.lpDesktop=const_cast<LPWSTR>(L"winsta0\\default");
    startup.dwFlags=STARTF_USESHOWWINDOW;startup.wShowWindow=SW_HIDE;
    PROCESS_INFORMATION process{};void* environment{};
    if(!CreateEnvironmentBlock(&environment,primary.h,FALSE))return;
    if(WaitForSingleObject(stopEvent,0)==WAIT_OBJECT_0)return;
    const BOOL created=CreateProcessAsUserW(primary.h,exe.c_str(),command.data(),nullptr,nullptr,FALSE,
        CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,environment,working.c_str(),&startup,&process);
    const DWORD createError=created?0:GetLastError();
    DestroyEnvironmentBlock(environment);if(!created){Trace("helper creation failed",createError);return;}
    Handle child(process.hProcess),thread(process.hThread);
    if(!AssignProcessToJobObject(job.h,child.h)){TerminateProcess(child.h,1);return;}
    if(WaitForSingleObject(stopEvent,0)==WAIT_OBJECT_0){TerminateJobObject(job.h,0);return;}
    ResumeThread(thread.h);
    Handle connected(CreateEventW(nullptr,TRUE,FALSE,nullptr));
    OVERLAPPED connection{};connection.hEvent=connected.h;
    BOOL connectedOk=ConnectNamedPipe(inner.h,&connection);
    DWORD connectionError=connectedOk?0:GetLastError();
    if(connectedOk||connectionError==ERROR_PIPE_CONNECTED)SetEvent(connected.h);
    HANDLE waits[]={connected.h,child.h,stopEvent};
    const DWORD outcome=WaitForMultipleObjects(3,waits,FALSE,8000);
    DWORD ignored{};
    if(outcome==WAIT_OBJECT_0&&connectionError==ERROR_IO_PENDING)
        connectedOk=GetOverlappedResult(inner.h,&connection,&ignored,FALSE);
    else connectedOk=connectedOk||connectionError==ERROR_PIPE_CONNECTED;
    if(outcome!=WAIT_OBJECT_0){CancelIoEx(inner.h,&connection);TerminateJobObject(job.h,1);
        if(connectionError==ERROR_IO_PENDING)GetOverlappedResult(inner.h,&connection,&ignored,TRUE);}
    ULONG agentPid{};
    if(outcome!=WAIT_OBJECT_0||!connectedOk||!GetNamedPipeClientProcessId(inner.h,&agentPid)||agentPid!=process.dwProcessId){Trace("agent handshake failed",outcome);return;}
    Trace(request.kind==1?"input helper connected":"capture helper connected");
    std::thread input([&]{Relay(outer.h,inner.h);
        if(request.kind==1){WriteAll(inner.h,"R\n",2);Sleep(100);}
        TerminateJobObject(job.h,0);CancelIoEx(inner.h,nullptr);});
    Relay(inner.h,outer.h);
    CancelIoEx(outer.h,nullptr);CancelIoEx(inner.h,nullptr);
    CancelSynchronousIo(input.native_handle());DisconnectNamedPipe(outer.h);input.join();
    Trace("helper session ended");
}
void WINAPI Control(DWORD code){if(code!=SERVICE_CONTROL_STOP)return;Status(SERVICE_STOP_PENDING);SetEvent(stopEvent);
    std::lock_guard guard(activeMutex);
    for(HANDLE job:activeJobs)if(job)TerminateJobObject(job,0);
    for(HANDLE pipe:activePipes)CancelIoEx(pipe,nullptr);
}
void WINAPI Main(DWORD,LPWSTR*){
    statusHandle=RegisterServiceCtrlHandlerW(serviceName,Control);if(!statusHandle)return;
    Trace("service entry");Status(SERVICE_START_PENDING);
    if(!remotedesk::IsSystemProcess()||!EnablePrivilege(SE_TCB_NAME)||!EnablePrivilege(SE_ASSIGNPRIMARYTOKEN_NAME)||
       !EnablePrivilege(SE_INCREASE_QUOTA_NAME)){Trace("required privilege unavailable",GetLastError());Status(SERVICE_STOPPED);return;}
    stopEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
    PSECURITY_DESCRIPTOR descriptor{};
    // Owner receives read/write data only, not FILE_CREATE_PIPE_INSTANCE.
    const std::wstring sddl=L"D:P(A;;GA;;;SY)(A;;0x0012019b;;;"+ownerSid+L")";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr)){Status(SERVICE_STOPPED);return;}
    SECURITY_ATTRIBUTES attributes{sizeof(attributes),descriptor,FALSE};bool first=true;
    while(WaitForSingleObject(stopEvent,0)!=WAIT_OBJECT_0){
        HANDLE pipe=CreateNamedPipeW(pipeName,PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|(first?FILE_FLAG_FIRST_PIPE_INSTANCE:0),
            PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,16,65536,65536,0,&attributes);
        if(pipe==INVALID_HANDLE_VALUE){Trace("public pipe creation failed",GetLastError());if(first)break;Sleep(200);continue;}
        if(first){Status(SERVICE_RUNNING);Trace("public pipe ready");}first=false;
        Handle connected(CreateEventW(nullptr,TRUE,FALSE,nullptr));OVERLAPPED operation{};operation.hEvent=connected.h;
        const BOOL immediate=ConnectNamedPipe(pipe,&operation);const DWORD error=immediate?0:GetLastError();
        if(immediate||error==ERROR_PIPE_CONNECTED)SetEvent(connected.h);
        else if(error!=ERROR_IO_PENDING){CloseHandle(pipe);continue;}
        HANDLE waits[]={connected.h,stopEvent};const DWORD outcome=WaitForMultipleObjects(2,waits,FALSE,INFINITE);
        if(outcome!=WAIT_OBJECT_0){CancelIoEx(pipe,&operation);DWORD ignored{};
            if(error==ERROR_IO_PENDING)GetOverlappedResult(pipe,&operation,&ignored,TRUE);CloseHandle(pipe);break;}
        if(WaitForSingleObject(stopEvent,0)==WAIT_OBJECT_0){CloseHandle(pipe);break;}
        if(workers>=8){CloseHandle(pipe);continue;}
        std::thread(Serve,pipe).detach();
    }
    LocalFree(descriptor);
    const ULONGLONG deadline=GetTickCount64()+5000;
    while(workers&&GetTickCount64()<deadline)Sleep(25);
    Status(SERVICE_STOPPED);
}
int Proxy(const Request& request){
    const ULONGLONG deadline=GetTickCount64()+2500;
    while(!WaitNamedPipeW(pipeName,100)){
        if(GetTickCount64()>=deadline){std::cerr<<"SYSTEM_HOST_ERROR service unavailable; error="<<GetLastError()<<"\n";return 2;}
        Sleep(50);
    }
    Handle pipe(CreateFileW(pipeName,pipeAccess,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr));
    ULONG pid{};
    if(pipe.h==INVALID_HANDLE_VALUE){std::cerr<<"SYSTEM_HOST_ERROR open pipe error="<<GetLastError()<<"\n";return 3;}
    if(!GetNamedPipeServerProcessId(pipe.h,&pid)){std::cerr<<"SYSTEM_HOST_ERROR server PID error="<<GetLastError()<<"\n";return 3;}
    SC_HANDLE manager=OpenSCManagerW(nullptr,nullptr,SC_MANAGER_CONNECT);
    // SCM is administrator-controlled. Querying its PID works from a normal
    // bridge process without requiring access to a SYSTEM process token.
    SC_HANDLE service=manager?OpenServiceW(manager,serviceName,SERVICE_QUERY_STATUS):nullptr;
    SERVICE_STATUS_PROCESS status{};DWORD required{};
    const bool trusted=service&&QueryServiceStatusEx(service,SC_STATUS_PROCESS_INFO,
        reinterpret_cast<BYTE*>(&status),sizeof(status),&required)&&status.dwProcessId==pid&&
        status.dwCurrentState==SERVICE_RUNNING;
    if(service)CloseServiceHandle(service);
    if(manager)CloseServiceHandle(manager);
    if(!trusted){
        std::cerr<<"SYSTEM_HOST_ERROR untrusted server\n";return 4;}
    if(!WriteAll(pipe.h,&request,sizeof(request)))return 5;
    if(request.kind==0){char ready[8]{};if(!ReadExact(pipe.h,ready,8)||std::string(ready,8)!="HOST_OK\n")return 6;
        std::cout<<"HOST_OK\n";return 0;}
    const HANDLE output=GetStdHandle(request.kind==1?STD_OUTPUT_HANDLE:STD_ERROR_HANDLE);
    std::thread input([&]{Relay(GetStdHandle(STD_INPUT_HANDLE),pipe.h,false,true);CancelIoEx(pipe.h,nullptr);});
    Relay(pipe.h,output,true,false);CancelIoEx(pipe.h,nullptr);CancelSynchronousIo(input.native_handle());input.join();return 0;
}
}
int wmain(int argc,wchar_t** argv){
    if(argc==2&&std::wstring(argv[1])==L"--pipe-self-test"){
        Handle token;OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.h);
        BYTE user[1024]{};DWORD size{};LPWSTR sid{};
        if(!GetTokenInformation(token.h,TokenUser,user,sizeof(user),&size)||
           !ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user)->User.Sid,&sid))return 1;
        const std::wstring acl=L"D:P(A;;GA;;;SY)(A;;0x0012019b;;;"+std::wstring(sid)+L")";LocalFree(sid);
        PSECURITY_DESCRIPTOR descriptor{};
        if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return 2;
        SECURITY_ATTRIBUTES attributes{sizeof(attributes),descriptor,FALSE};
        const std::wstring name=L"\\\\.\\pipe\\RemoteDesk.PipeTest."+std::to_wstring(GetCurrentProcessId());
        Handle server(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_FIRST_PIPE_INSTANCE|FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,1024,1024,0,&attributes));
        LocalFree(descriptor);if(server.h==INVALID_HANDLE_VALUE)return 3;
        Handle connected(CreateEventW(nullptr,TRUE,FALSE,nullptr));OVERLAPPED connection{};connection.hEvent=connected.h;
        const BOOL immediate=ConnectNamedPipe(server.h,&connection);const DWORD connectError=immediate?0:GetLastError();
        std::atomic<DWORD> error{};
        std::thread client([&]{Handle pipe(CreateFileW(name.c_str(),pipeAccess,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr));
            ULONG pid{};if(pipe.h==INVALID_HANDLE_VALUE){error=GetLastError();std::cout<<"Open failed "<<error<<"\n";}else if(!GetNamedPipeServerProcessId(pipe.h,&pid)){error=GetLastError();std::cout<<"PID query failed "<<error<<"\n";}
            else {char reply[4]{};if(!ReadExact(pipe.h,reply,4)||std::string(reply,4)!="PONG"||!WriteAll(pipe.h,"PING",4))error=GetLastError();}
        });
        if(!immediate&&connectError==ERROR_IO_PENDING){
            if(WaitForSingleObject(connected.h,3000)!=WAIT_OBJECT_0){CancelIoEx(server.h,&connection);client.join();return 4;}
            DWORD ignored{};if(!GetOverlappedResult(server.h,&connection,&ignored,FALSE)){client.join();return 4;}
        }
        char request[4]{};
        std::thread reader([&]{if(!ReadExact(server.h,request,4))error=GetLastError();});
        if(!WriteAll(server.h,"PONG",4))error=GetLastError();
        client.join();reader.join();
        if(std::string(request,4)!="PING")error=ERROR_INVALID_DATA;
        std::cout<<"Pipe access/PID test error="<<error<<"\n";return error?4:0;
    }
    if(argc==3&&std::wstring(argv[1])==L"--service"){
        ownerSid=argv[2];PSID sid{};
        if(!ConvertStringSidToSidW(ownerSid.c_str(),&sid))return 2;LocalFree(sid);
        wchar_t path[32768]{};GetModuleFileNameW(nullptr,path,32768);root=path;root=root.substr(0,root.find_last_of(L"\\"));
        wchar_t programData[32768]{};GetEnvironmentVariableW(L"ProgramData",programData,32768);dataRoot=std::wstring(programData)+L"\\RemoteDeskHost";
        SERVICE_TABLE_ENTRYW table[]={{const_cast<LPWSTR>(serviceName),Main},{nullptr,nullptr}};
        if(!StartServiceCtrlDispatcherW(table))return static_cast<int>(GetLastError());
        ExitProcess(0); // Do not run static destructors while a canceled worker unwinds.
    }
    if(argc==2&&std::wstring(argv[1])==L"--self-test"){
        Request r{};if(!Valid(r))return 1;r.kind=2;r.port=443;if(Valid(r))return 2;
        r.port=55445;r.mode=1;if(!Valid(r))return 3;r.flags=32;if(Valid(r))return 4;
        std::cout<<"Host request bounds passed; no privileged process launched\n";return 0;
    }
    Request r{};
    if(argc<2)return 2;
    const std::wstring kind=argv[1];r.kind=kind==L"--input"?1:kind==L"--capture"?2:0;
    if(r.kind==0&&kind!=L"--status")return 2;
    for(int i=2;i<argc;++i){const std::wstring a=argv[i];
        if(a.size()==13&&a.rfind(L"--display=",0)==0&&a[10]>=L'0'&&a[10]<=L'9'&&a[11]==L':'&&a[12]>=L'0'&&a[12]<=L'9'){
            r.adapter=a[10]-L'0';r.output=a[12]-L'0';}
        else if(a.rfind(L"--tcp-port=",0)==0){try{size_t count{};auto value=std::stoul(a.substr(11),&count);if(count!=a.size()-11||value>65535)return 2;r.port=static_cast<DWORD>(value);}catch(...){return 2;}}
        else if(a==L"--network-1080-60-live")r.mode=0;
        else if(a==L"--network-native-60-live")r.mode=1;
        else if(a==L"--network-60-live")r.mode=2;
        else if(a==L"--network-1080-30-live")r.mode=3;
        else if(a==L"--wan-video")r.flags|=1;
        else if(a==L"--wan-video-mobile")r.flags|=2;
        else if(a==L"--recovery-keyframes"||a==L"--adaptive-recovery")r.flags|=4;
        else if(a==L"--cpu-conversion")r.flags|=8;
        else if(a==L"--client=pc")r.profile=1;
        else return 2;
    }
    if(!Valid(r))return 2;return Proxy(r);
}
