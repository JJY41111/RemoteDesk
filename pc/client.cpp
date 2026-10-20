#include "native-transport.h"
#include <rtc/rtc.hpp>
#include <nlohmann/json.hpp>
#include "audio-output.h"
#include "receiver-feedback.h"
#include "frame-surface.h"
#include "video-queue.h"
#include "h264_network_decoder.h"
#include <commctrl.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>
#include <windowsx.h>
#include <xinput.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <thread>
#include <set>
#include <chrono>
#include <algorithm>
#include <fstream>
#include <optional>
#include <map>
#include <cstring>
#include <gdiplus.h>

using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
constexpr UINT FrameMessage=WM_APP+1,StatusMessage=WM_APP+2,FinishedMessage=WM_APP+3;
constexpr char NativeClientVersion[]="2026-10-16.3";
constexpr int ConnectId=101,DisconnectId=102,ControlId=103,MouseId=104,FullId=105,AudioId=106,TrustId=107,GamepadId=108;
struct Frame {rtc::binary bytes;uint32_t timestamp{};};
struct VideoImage {std::vector<uint8_t> pixels;unsigned width,height;};
static std::wstring Text(HWND window){int size=GetWindowTextLengthW(window);std::wstring value(size+1,L'\0');GetWindowTextW(window,value.data(),size+1);value.resize(size);return value;}
static bool Keyframe(const rtc::binary& data){
    for(size_t i=0;i+4<data.size();++i)if(data[i]==std::byte{0} && data[i+1]==std::byte{0} &&
       ((data[i+2]==std::byte{1} && (std::to_integer<unsigned>(data[i+3])&31)==5) ||
        (data[i+2]==std::byte{0} && data[i+3]==std::byte{1} && (std::to_integer<unsigned>(data[i+4])&31)==5)))return true;
    return false;
}
static std::string KeyCode(const RAWKEYBOARD& key){
    const UINT vk=key.VKey;const bool extended=(key.Flags&RI_KEY_E0)!=0;
    if(vk>='A' && vk<='Z')return std::string("Key")+char(vk);
    if(vk>='0' && vk<='9')return std::string("Digit")+char(vk);
    if(vk>=VK_F1 && vk<=VK_F12)return "F"+std::to_string(vk-VK_F1+1);
    if(vk>=VK_NUMPAD0 && vk<=VK_NUMPAD9)return "Numpad"+std::to_string(vk-VK_NUMPAD0);
    switch(vk){
    case VK_SHIFT:case VK_LSHIFT:case VK_RSHIFT:return key.MakeCode==0x36?"ShiftRight":"ShiftLeft";
    case VK_CONTROL:case VK_LCONTROL:case VK_RCONTROL:return extended?"ControlRight":"ControlLeft";
    case VK_MENU:case VK_LMENU:case VK_RMENU:return extended?"AltRight":"AltLeft";
    case VK_LWIN:return "MetaLeft";case VK_RWIN:return "MetaRight";
    case VK_SPACE:return "Space";case VK_RETURN:return extended?"NumpadEnter":"Enter";
    case VK_TAB:return "Tab";case VK_BACK:return "Backspace";case VK_ESCAPE:return "Escape";
    case VK_CAPITAL:return "CapsLock";case VK_LEFT:return "ArrowLeft";case VK_RIGHT:return "ArrowRight";
    case VK_UP:return "ArrowUp";case VK_DOWN:return "ArrowDown";case VK_HOME:return "Home";
    case VK_END:return "End";case VK_PRIOR:return "PageUp";case VK_NEXT:return "PageDown";
    case VK_INSERT:return "Insert";case VK_DELETE:return "Delete";
    case VK_OEM_1:return "Semicolon";case VK_OEM_PLUS:return "Equal";case VK_OEM_COMMA:return "Comma";
    case VK_OEM_MINUS:return "Minus";case VK_OEM_PERIOD:return "Period";case VK_OEM_2:return "Slash";
    case VK_OEM_3:return "Backquote";case VK_OEM_4:return "BracketLeft";case VK_OEM_5:return "Backslash";
    case VK_OEM_6:return "BracketRight";case VK_OEM_7:return "Quote";
    case VK_MULTIPLY:return "NumpadMultiply";case VK_ADD:return "NumpadAdd";case VK_SUBTRACT:return "NumpadSubtract";
    case VK_DECIMAL:return "NumpadDecimal";case VK_DIVIDE:return "NumpadDivide";default:return {};
    }
}

class Client {
public:
    HWND window=nullptr,canvas=nullptr,urlField=nullptr,codeField=nullptr,modeField=nullptr,caField=nullptr,statusField=nullptr;
    HWND connectButton=nullptr,controlButton=nullptr,mouseButton=nullptr,audioButton=nullptr;
    HWND gamepadButton=nullptr;
    std::filesystem::path settings;
    std::atomic_bool running=false,controlReady=false,controlRequested=false,relativeReady=false;
    std::atomic_bool gamepadReady=false;
    bool gamepadRequested=false;
    LONG rawX=0,rawY=0;
    unsigned gamepadSequence=0;
    unsigned pointerSequence=0;
    unsigned generation=0;
    bool locked=false,fullscreen=false;
    RECT oldRect{};LONG_PTR oldStyle{};
    std::set<std::string> keys;std::set<int> buttons;
    std::mutex queueMutex,frameMutex,imageMutex,peerMutex,statusMutex;
    std::condition_variable queueCondition,frameCondition;
    std::deque<std::string> outbound;VideoQueue<Frame> frames;
    std::shared_ptr<const VideoImage> latestImage;
    std::atomic_uint sourceWidth=0,sourceHeight=0,sourceFps=60;
    std::atomic<HINTERNET> websocket=nullptr,request=nullptr;
    std::thread receiveThread,sendThread,decodeThread;
    std::shared_ptr<rtc::PeerConnection> peer;
    std::vector<std::shared_ptr<rtc::Track>> tracks;
    std::vector<std::shared_ptr<rtc::DataChannel>> channels;
    AudioOutput audio;
    std::shared_ptr<ReceiverFeedback> feedback=std::make_shared<ReceiverFeedback>();
    std::atomic_ullong decoded=0,queueDrops=0,received=0,painted=0;
    std::atomic_ullong waitingDrops=0,recoveryRequests=0,decoderResets=0;
    std::atomic<int64_t> lastRecoveryAt=0;
    std::atomic<double> receiveFps=0,decodeFps=0,presentFps=0;
    Clock::time_point lastRateAt{};
    uint64_t rateReceived=0,rateDecoded=0,ratePainted=0;
    std::atomic<int64_t> lastVideoAt=0;
    std::atomic<double> decodeMs=0;
    std::wstring lastStatus=L"尚未連線";
    std::wstring normalStatus=L"尚未連線";
    std::atomic_bool hostCapturePaused=false,hostInputBlocked=false;
    std::atomic_uint capturePauses=0,captureResumes=0;
    Clock::time_point started{};
    std::filesystem::path testReport;
    std::filesystem::path testScreenshot;
    unsigned offscreenRenders=0;
    FrameSurface frameSurface;
    unsigned bufferedPresents=0,presentFailures=0,simulatedMouseMoves=0;
    bool testMouseRepaint=false;
    int testDecodeDelayMs=0;
    int testSeconds=0;
    bool testMode=false;
    ~Client(){Stop();}
    void RefreshStatusLocked(){
        lastStatus=hostCapturePaused?L"主機桌面暫時無法擷取；若有 Windows 權限提示，請在主機處理後等待恢復":
            hostInputBlocked?L"Windows 拒絕遠端輸入；請返回一般桌面後重試":normalStatus;
        PostMessageW(window,StatusMessage,0,0);
    }
    void Status(const std::wstring& text){std::lock_guard lock(statusMutex);normalStatus=text;RefreshStatusLocked();}
    void Send(Json value){
        if(!running)return;
        const auto text=value.dump();
        std::lock_guard lock(queueMutex);
        if(outbound.size()>=256){auto handle=websocket.exchange(nullptr);if(handle)WinHttpCloseHandle(handle);running=false;Status(L"控制通道壅塞，已中止連線以釋放按鍵");}
        else outbound.push_back(text);
        queueCondition.notify_one();
    }
    void RequestRecovery(){
        const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
        auto previous=lastRecoveryAt.load();
        if(now-previous>=1000 && lastRecoveryAt.compare_exchange_strong(previous,now)){
            ++recoveryRequests;Send({{"type","request-video-recovery"}});
        }
    }
    void Input(Json value){
        const auto type=value.value("type",std::string{});
        const bool pointer=(type=="move" || type=="move-relative") && !value.value("reliable",false);
        if(pointer)value["seq"]=++pointerSequence;
        std::shared_ptr<rtc::DataChannel> channel;
        {std::lock_guard lock(peerMutex);for(const auto& item:channels)if(item->label()==(pointer?"pointer":"control"))channel=item;}
        try{
            if(channel && channel->isOpen()){
                if(channel->bufferedAmount()<32768){channel->send(value.dump());return;}
                if(pointer)return;
            }
        }catch(...){}
        Send({{"type","control"},{"input",std::move(value)}});
    }
    void Release(){
        for(const auto& key:keys)Input({{"type","key"},{"code",key},{"down",false}});
        for(const int button:buttons)Input({{"type","button"},{"button",button},{"down",false}});
        keys.clear();buttons.clear();
        rawX=rawY=0;
    }
    void Unlock(){
        if(!locked)return;
        Release();locked=false;relativeReady=false;ClipCursor(nullptr);ReleaseCapture();ShowCursor(TRUE);
        Send({{"type","set-mouse-mode"},{"mode","desktop"}});SetWindowTextW(mouseButton,L"遊戲滑鼠");
    }
    void Lock(){
        if(!controlReady || !controlRequested){Status(L"請先啟用操作，等候主機確認");return;}
        Release();RECT rect{};GetClientRect(canvas,&rect);MapWindowPoints(canvas,nullptr,reinterpret_cast<POINT*>(&rect),2);
        ClipCursor(&rect);SetCapture(canvas);ShowCursor(FALSE);locked=true;relativeReady=false;
        Send({{"type","set-mouse-mode"},{"mode","relative"}});SetWindowTextW(mouseButton,L"Esc 釋放滑鼠");SetFocus(canvas);
    }
    std::shared_ptr<const VideoImage> Image(){std::lock_guard lock(imageMutex);return latestImage;}
    RECT ImageRect(const VideoImage* image=nullptr){
        const auto snapshot=image?std::shared_ptr<const VideoImage>{}:Image();
        if(!image)image=snapshot.get();
        RECT rect{};GetClientRect(canvas,&rect);
        if(!image || !image->width || !image->height)return rect;
        const double scale=std::min(double(rect.right)/image->width,double(rect.bottom)/image->height);
        const LONG w=LONG(image->width*scale),h=LONG(image->height*scale);
        return {(rect.right-w)/2,(rect.bottom-h)/2,(rect.right+w)/2,(rect.bottom+h)/2};
    }
    void Move(int x,int y,bool reliable=false){
        if(!controlReady || !controlRequested || locked)return;
        const RECT rect=ImageRect();
        if(x<rect.left || x>=rect.right || y<rect.top || y>=rect.bottom)return;
        Input({{"type","move"},{"x",std::clamp(double(x-rect.left)/std::max<LONG>(rect.right-rect.left-1,1),0.,1.)},
          {"y",std::clamp(double(y-rect.top)/std::max<LONG>(rect.bottom-rect.top-1,1),0.,1.)},{"reliable",reliable}});
    }
    void CanvasCursor(){
        POINT point{};
        const bool positioned=GetCursorPos(&point) && ScreenToClient(canvas,&point);
        const RECT image=ImageRect();
        const bool hide=positioned && running && controlReady && controlRequested && decoded>0 &&
            !hostCapturePaused && !hostInputBlocked && GetForegroundWindow()==window && PtInRect(&image,point);
        // SetCursor is scoped to the window under the pointer. Do not change
        // the global ShowCursor counter for ordinary desktop operation.
        SetCursor(hide?nullptr:LoadCursorW(nullptr,IDC_ARROW));
    }
    void RefreshLocalCursor(){
        POINT point{};
        if(canvas && GetCursorPos(&point) && WindowFromPoint(point)==canvas)CanvasCursor();
    }
    void Button(int button,bool down){
        if(!controlReady || !controlRequested)return;
        if(down==buttons.contains(button))return;
        Input({{"type","button"},{"button",button},{"down",down}});
        if(down)buttons.insert(button);else buttons.erase(button);
    }
    void Raw(HRAWINPUT handle){
        if(!controlReady || !controlRequested || GetForegroundWindow()!=window || GetFocus()!=canvas)return;
        UINT size=0;GetRawInputData(handle,RID_INPUT,nullptr,&size,sizeof(RAWINPUTHEADER));
        if(size>4096)return;std::vector<BYTE> data(size);
        if(GetRawInputData(handle,RID_INPUT,data.data(),&size,sizeof(RAWINPUTHEADER))==UINT(-1))return;
        const auto& input=*reinterpret_cast<RAWINPUT*>(data.data());
        if(input.header.dwType==RIM_TYPEKEYBOARD){
            const auto& key=input.data.keyboard;
            const bool down=(key.Flags&RI_KEY_BREAK)==0;
            if(key.VKey==VK_ESCAPE && locked){if(down)Unlock();return;}
            const std::string code=KeyCode(key);if(code.empty() || down==keys.contains(code))return;
            Input({{"type","key"},{"code",code},{"down",down}});
            if(down)keys.insert(code);else keys.erase(code);
        }else if(input.header.dwType==RIM_TYPEMOUSE && locked && relativeReady){
            const auto& mouse=input.data.mouse;
            if(!(mouse.usFlags&MOUSE_MOVE_ABSOLUTE)){
                rawX=std::clamp<LONG>(rawX+mouse.lLastX,-2048,2048);rawY=std::clamp<LONG>(rawY+mouse.lLastY,-2048,2048);
            }
            if(mouse.usButtonFlags&RI_MOUSE_LEFT_BUTTON_DOWN)Button(0,true);
            if(mouse.usButtonFlags&RI_MOUSE_LEFT_BUTTON_UP)Button(0,false);
            if(mouse.usButtonFlags&RI_MOUSE_RIGHT_BUTTON_DOWN)Button(2,true);
            if(mouse.usButtonFlags&RI_MOUSE_RIGHT_BUTTON_UP)Button(2,false);
            if(mouse.usButtonFlags&RI_MOUSE_MIDDLE_BUTTON_DOWN)Button(1,true);
            if(mouse.usButtonFlags&RI_MOUSE_MIDDLE_BUTTON_UP)Button(1,false);
            if(mouse.usButtonFlags&RI_MOUSE_WHEEL)Input({{"type","wheel"},{"delta",static_cast<short>(mouse.usButtonData)}});
        }
    }
    void PollInput(){
        if(locked && relativeReady && controlReady && (rawX || rawY)){
            Input({{"type","move-relative"},{"dx",rawX},{"dy",rawY}});rawX=rawY=0;
        }
        if(!gamepadRequested || !gamepadReady || !controlRequested || GetForegroundWindow()!=window || GetFocus()!=canvas)return;
        XINPUT_STATE state{};bool found=false;
        for(DWORD index=0;index<4;++index)if(XInputGetState(index,&state)==ERROR_SUCCESS){found=true;break;}
        std::array<double,17> values{};std::array<double,4> axes{};
        if(found){
            const auto& pad=state.Gamepad;
            constexpr WORD masks[]={XINPUT_GAMEPAD_A,XINPUT_GAMEPAD_B,XINPUT_GAMEPAD_X,XINPUT_GAMEPAD_Y,
              XINPUT_GAMEPAD_LEFT_SHOULDER,XINPUT_GAMEPAD_RIGHT_SHOULDER,0,0,XINPUT_GAMEPAD_BACK,XINPUT_GAMEPAD_START,
              XINPUT_GAMEPAD_LEFT_THUMB,XINPUT_GAMEPAD_RIGHT_THUMB,XINPUT_GAMEPAD_DPAD_UP,XINPUT_GAMEPAD_DPAD_DOWN,
              XINPUT_GAMEPAD_DPAD_LEFT,XINPUT_GAMEPAD_DPAD_RIGHT,0};
            for(size_t i=0;i<values.size();++i)values[i]=(pad.wButtons&masks[i])?1:0;
            values[6]=pad.bLeftTrigger/255.;values[7]=pad.bRightTrigger/255.;
            const auto axis=[](SHORT value,int deadzone){return std::abs(int(value))<=deadzone?0.:std::clamp(value/32767.,-1.,1.);};
            axes={axis(pad.sThumbLX,XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE),-axis(pad.sThumbLY,XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE),
              axis(pad.sThumbRX,XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE),-axis(pad.sThumbRY,XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE)};
        }
        Json input={{"type","gamepad"},{"buttons",values},{"axes",axes},{"seq",++gamepadSequence}};
        std::shared_ptr<rtc::DataChannel> channel;
        {std::lock_guard lock(peerMutex);for(const auto& item:channels)if(item->label()=="gamepad")channel=item;}
        try{if(channel && channel->isOpen() && channel->bufferedAmount()<8192)channel->send(input.dump());else Input(input);}catch(...){}
    }
    void NeutralGamepad(){
        if(gamepadRequested)Input({{"type","gamepad"},{"buttons",std::array<double,17>{}},
          {"axes",std::array<double,4>{}},{"seq",++gamepadSequence}});
    }
    void Save(){
        Json value={{"url",Utf8(Text(urlField))},{"ca",Utf8(Text(caField))},{"videoMode",SendMessageW(modeField,CB_GETCURSEL,0,0)==1?"native":"1080p"},
          {"audio",SendMessageW(audioButton,BM_GETCHECK,0,0)==BST_CHECKED}};
        std::filesystem::create_directories(settings.parent_path());
        std::ofstream(settings)<<value.dump(2); // No pairing code or control consent is persisted.
    }
    void Load(){
        try{std::ifstream file(settings);Json value;file>>value;SetWindowTextW(urlField,Wide(value.value("url",std::string{})).c_str());
            SetWindowTextW(caField,Wide(value.value("ca",std::string{})).c_str());SendMessageW(modeField,CB_SETCURSEL,value.value("videoMode",std::string{})=="native"?1:0,0);
            SendMessageW(audioButton,BM_SETCHECK,value.value("audio",true)?BST_CHECKED:BST_UNCHECKED,0);}catch(...){}
    }
    void FrameReceived(rtc::binary bytes,rtc::FrameInfo info){
        if(!running || bytes.empty() || bytes.size()>16*1024*1024)return;
        ++received;const bool key=Keyframe(bytes);
        lastVideoAt=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
        std::lock_guard lock(frameMutex);
        const auto result=frames.Push(Frame{std::move(bytes),info.timestamp},key,lastVideoAt.load());
        queueDrops+=result.dropped;waitingDrops+=result.waitingDropped;
        if(result.requestRecovery)RequestRecovery();
        frameCondition.notify_one();
    }
    void DecodeLoop(){
        CoInitializeEx(nullptr,COINIT_MULTITHREADED);
        try{
            std::unique_ptr<remotedesk::H264NetworkDecoder> decoder;
            unsigned w=0,h=0,fps=0;uint64_t sample=0,decodeGeneration=0;
            while(running){
                VideoQueue<Frame>::Entry entry;
                {std::unique_lock lock(frameMutex);frameCondition.wait_for(lock,std::chrono::milliseconds(100),[&]{return !running || (!frames.empty() && sourceWidth.load());});
                    if(!running)break;if(frames.empty() || !sourceWidth.load())continue;entry=frames.Pop();}
                Frame& frame=entry.frame;
                if(entry.generation!=decodeGeneration){if(decoder)++decoderResets;decoder.reset();w=0;sample=0;decodeGeneration=entry.generation;}
                if(w!=sourceWidth || h!=sourceHeight || fps!=sourceFps){
                    if(!entry.key){RequestRecovery();continue;}
                    decoder.reset();w=sourceWidth;h=sourceHeight;fps=sourceFps;
                    if(w>7680 || h>4320 || w%2 || h%2 || !w || !h || !fps || fps>120)throw std::runtime_error("Unsupported host video dimensions");
                    decoder=std::make_unique<remotedesk::H264NetworkDecoder>();
                    decoder->Start(w,h,fps,[this](std::vector<uint8_t>&& bytes,unsigned width,unsigned height,uint64_t){
                        auto image=std::make_shared<VideoImage>(VideoImage{std::move(bytes),width,height});
                        {std::lock_guard lock(imageMutex);latestImage=std::move(image);}
                        if(++decoded==1)Status(L"原生影音接收中；勾選遠端操作後點畫面聚焦");PostMessageW(canvas,FrameMessage,0,0);
                    });
                }
                const auto start=Clock::now();
                if(testMode && testDecodeDelayMs)std::this_thread::sleep_for(std::chrono::milliseconds(testDecodeDelayMs));
                std::vector<uint8_t> bytes(frame.bytes.size());std::memcpy(bytes.data(),frame.bytes.data(),bytes.size());
                try{decoder->DecodePacket(bytes,sample,10000000/fps);sample+=10000000/fps;}
                catch(...){decoder.reset();w=0;++decoderResets;std::lock_guard lock(frameMutex);queueDrops+=frames.size();frames.clear();RequestRecovery();continue;}
                decodeMs=std::chrono::duration<double,std::milli>(Clock::now()-start).count();
            }
        }catch(const std::exception& error){Status(Wide(error.what()));}
        CoUninitialize();
    }
    void SetupPeer(){
        auto connection=std::make_shared<rtc::PeerConnection>();
        {std::lock_guard lock(peerMutex);peer=connection;}
        connection->onLocalDescription([this](rtc::Description description){Send({{"type","description"},{"descriptionType",description.typeString()},{"sdp",std::string(description)}});});
        connection->onLocalCandidate([this](rtc::Candidate candidate){Send({{"type","candidate"},{"candidate",std::string(candidate)},{"mid",candidate.mid()}});});
        connection->onStateChange([this](rtc::PeerConnection::State state){
            if(state==rtc::PeerConnection::State::Connected)Status(L"WebRTC 已連線，等待主機畫面");
            if(state==rtc::PeerConnection::State::Failed)Status(L"WebRTC 連線失敗，請斷線後重試");
        });
        connection->onDataChannel([this](std::shared_ptr<rtc::DataChannel> channel){
            channel->onMessage([](rtc::binary){},[this](std::string value){try{Handle(Json::parse(value));}catch(...){}});
            std::lock_guard lock(peerMutex);channels.push_back(channel);
        });
        connection->onTrack([this](std::shared_ptr<rtc::Track> track){
            if(track->description().type()=="video"){
                auto session=std::make_shared<rtc::RtcpReceivingSession>();
                session->addToChain(feedback);
                auto depacketizer=std::make_shared<rtc::H264RtpDepacketizer>();
                depacketizer->addToChain(session);track->setMediaHandler(depacketizer);
                track->onFrame([this](rtc::binary data,rtc::FrameInfo info){FrameReceived(std::move(data),info);});
            }else if(track->description().type()=="audio"){
                auto session=std::make_shared<rtc::RtcpReceivingSession>();auto depacketizer=std::make_shared<rtc::OpusRtpDepacketizer>();depacketizer->addToChain(session);track->setMediaHandler(depacketizer);
                track->onFrame([this](rtc::binary data,rtc::FrameInfo){if(running)audio.Push(data);});
            }
            std::lock_guard lock(peerMutex);tracks.push_back(track);
        });
    }
    void Handle(const Json& message){
        const auto type=message.value("type",std::string{});
        if(type=="description"){
            std::shared_ptr<rtc::PeerConnection> connection;{std::lock_guard lock(peerMutex);connection=peer;}
            if(connection)connection->setRemoteDescription(rtc::Description(message.at("sdp").get<std::string>(),message.at("descriptionType").get<std::string>()));
        }else if(type=="candidate"){
            std::shared_ptr<rtc::PeerConnection> connection;{std::lock_guard lock(peerMutex);connection=peer;}
            if(connection)connection->addRemoteCandidate(rtc::Candidate(message.at("candidate").get<std::string>(),message.at("mid").get<std::string>()));
        }else if(type=="stats"){
            sourceWidth=message.value("width",0u);sourceHeight=message.value("height",0u);sourceFps=message.value("fps",60u);frameCondition.notify_one();
        }else if(type=="control-state"){
            controlReady=message.value("enabled",false);Status(controlReady?L"遠端操作就緒；點畫面聚焦，遊戲滑鼠按 Esc 釋放":L"遠端操作已停用／等待主機");
        }else if(type=="capture-state"){
            std::lock_guard lock(statusMutex);hostCapturePaused=message.value("paused",false);
            if(hostCapturePaused)++capturePauses;else ++captureResumes;RefreshStatusLocked();
        }else if(type=="input-access-state"){
            std::lock_guard lock(statusMutex);hostInputBlocked=message.value("blocked",false);RefreshStatusLocked();
        }else if(type=="mouse-mode")relativeReady=message.value("mode",std::string{})=="relative";
        else if(type=="gamepad-state")gamepadReady=message.value("enabled",false);
        else if(type=="error" || type=="audio-error")Status(Wide(message.value("text",std::string("Host error"))));
    }
    void SendLoop(){
        while(running){std::string message;
            {std::unique_lock lock(queueMutex);queueCondition.wait(lock,[&]{return !running || !outbound.empty();});if(!running)break;message=std::move(outbound.front());outbound.pop_front();}
            auto handle=websocket.load();if(!handle)break;
            if(WinHttpWebSocketSend(handle,WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,message.data(),static_cast<DWORD>(message.size()))!=NO_ERROR){
                Status(L"控制通道已中斷");auto socket=websocket.exchange(nullptr);if(socket)WinHttpCloseHandle(socket);break;
            }
        }
    }
    void Receive(std::wstring url,std::wstring code,std::wstring ca,std::string mode,bool playAudio,unsigned run){
        HINTERNET http=nullptr,host=nullptr;
        try{
            const auto address=NativeUrl::Parse(url);
            http=WinHttpOpen(L"RemoteDesk-Windows/0.1",WINHTTP_ACCESS_TYPE_NO_PROXY,WINHTTP_NO_PROXY_NAME,WINHTTP_NO_PROXY_BYPASS,0);
            HttpCheck(http!=nullptr,"Open HTTPS");WinHttpSetTimeouts(http,5000,5000,5000,5000);
            host=WinHttpConnect(http,address.host.c_str(),address.port,0);HttpCheck(host!=nullptr,"Connect host");
            const auto req=WinHttpOpenRequest(host,L"GET",L"/signal",nullptr,WINHTTP_NO_REFERER,WINHTTP_DEFAULT_ACCEPT_TYPES,WINHTTP_FLAG_SECURE);
            request=req;HttpCheck(req!=nullptr,"Open signaling");
            HttpCheck(WinHttpSetOption(req,WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET,nullptr,0),"Upgrade signaling");
            DWORD redirects=WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
            HttpCheck(WinHttpSetOption(req,WINHTTP_OPTION_REDIRECT_POLICY,&redirects,sizeof(redirects)),"Disable redirects");
            if(!ca.empty()){
                DWORD flags=SECURITY_FLAG_IGNORE_UNKNOWN_CA;
                HttpCheck(WinHttpSetOption(req,WINHTTP_OPTION_SECURITY_FLAGS,&flags,sizeof(flags)),"Use explicit private CA");
            }
            HttpCheck(WinHttpSendRequest(req,L"X-RemoteDesk-Client: pc-native-v1\r\n",DWORD(-1L),nullptr,0,0,0),"HTTPS handshake (check CA trust)");
            HttpCheck(WinHttpReceiveResponse(req,nullptr),"Receive host response");
            if(!ca.empty())VerifyPrivateCA(req,address.host,ca);
            DWORD status=0,size=sizeof(status);
            HttpCheck(WinHttpQueryHeaders(req,WINHTTP_QUERY_STATUS_CODE|WINHTTP_QUERY_FLAG_NUMBER,nullptr,&status,&size,nullptr),"Read response");
            if(status!=101)throw std::runtime_error("PC service refused connection (HTTP "+std::to_string(status)+")");
            auto socket=WinHttpWebSocketCompleteUpgrade(req,0);HttpCheck(socket!=nullptr,"Open WebSocket");
            websocket=socket;if(auto handle=request.exchange(nullptr))WinHttpCloseHandle(handle);
            if(!running)throw std::runtime_error("Connection cancelled");
            SetupPeer();
            try{audio.Start();audio.SetEnabled(playAudio);}catch(const std::exception& error){Status(Wide(error.what()));}
            sendThread=std::thread([this]{SendLoop();});decodeThread=std::thread([this]{DecodeLoop();});
            Send({{"type","pair"},{"code",Utf8(code)},{"clientType","pc"},{"clientVersion",NativeClientVersion},{"syncMode","interactive"},{"videoMode",mode},{"audioOnDemand",false}});
            SecureZeroMemory(code.data(),code.size()*sizeof(wchar_t));
            std::string message;std::array<char,16384> buffer{};
            while(running){
                DWORD count=0;WINHTTP_WEB_SOCKET_BUFFER_TYPE type{};
                const DWORD error=WinHttpWebSocketReceive(socket,buffer.data(),static_cast<DWORD>(buffer.size()),&count,&type);
                if(error!=NO_ERROR || type==WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE)break;
                if(type!=WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE && type!=WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)throw std::runtime_error("Unexpected signaling message");
                message.append(buffer.data(),count);if(message.size()>256*1024)throw std::runtime_error("Signaling message too large");
                if(type==WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE){Handle(Json::parse(message));message.clear();}
            }
            if(running)Status(L"主機已斷線；檢查配對碼或按連線重試");
        }catch(const std::exception& error){if(running)Status(Wide(error.what()));}
        running=false;controlReady=false;relativeReady=false;queueCondition.notify_all();frameCondition.notify_all();
        if(auto socket=websocket.exchange(nullptr))WinHttpCloseHandle(socket);
        if(auto req=request.exchange(nullptr))WinHttpCloseHandle(req);
        if(sendThread.joinable())sendThread.join();
        {std::shared_ptr<rtc::PeerConnection> connection;{std::lock_guard lock(peerMutex);connection=std::move(peer);}
            if(connection){connection->resetCallbacks();connection->close();}std::lock_guard lock(peerMutex);tracks.clear();channels.clear();}
        if(decodeThread.joinable())decodeThread.join();audio.Stop();
        if(host)WinHttpCloseHandle(host);if(http)WinHttpCloseHandle(http);
        PostMessageW(window,FinishedMessage,run,0);
    }
    void Start(){
        if(running)return;Stop();
        const auto url=Text(urlField),code=Text(codeField),ca=Text(caField);
        try{NativeUrl::Parse(url);if(code.size()!=8 || !std::all_of(code.begin(),code.end(),[](wchar_t c){return c>=L'0' && c<=L'9';}))throw std::runtime_error("Pairing code must be eight digits");Save();}
        catch(const std::exception& error){Status(Wide(error.what()));return;}
        sourceWidth=0;sourceHeight=0;decoded=0;received=0;queueDrops=0;painted=0;lastVideoAt=0;capturePauses=0;captureResumes=0;
        waitingDrops=0;recoveryRequests=0;decoderResets=0;lastRecoveryAt=0;receiveFps=decodeFps=presentFps=0;
        rateReceived=rateDecoded=ratePainted=0;started=lastRateAt=Clock::now();
        feedback=std::make_shared<ReceiverFeedback>();
        running=true;EnableWindow(connectButton,FALSE);SetWindowTextW(codeField,L"");Status(L"正在驗證主機憑證並連線…");
        const std::string mode=SendMessageW(modeField,CB_GETCURSEL,0,0)==1?"native":"1080p";
        const bool sound=SendMessageW(audioButton,BM_GETCHECK,0,0)==BST_CHECKED;
        const unsigned run=++generation;
        receiveThread=std::thread([this,url,code,ca,mode,sound,run]{Receive(url,code,ca,mode,sound,run);});
    }
    void Stop(){
        Unlock();Release();NeutralGamepad();gamepadRequested=false;gamepadReady=false;if(controlRequested)Send({{"type","set-control"},{"enabled",false}});
        running=false;controlRequested=false;controlReady=false;relativeReady=false;
        RefreshLocalCursor();
        if(auto socket=websocket.exchange(nullptr))WinHttpCloseHandle(socket);
        if(auto req=request.exchange(nullptr))WinHttpCloseHandle(req);
        queueCondition.notify_all();frameCondition.notify_all();
        if(receiveThread.joinable())receiveThread.join();
        {std::lock_guard lock(statusMutex);hostCapturePaused=false;hostInputBlocked=false;RefreshStatusLocked();}
        {std::lock_guard lock(queueMutex);outbound.clear();}{std::lock_guard lock(frameMutex);frames.clear();}{std::lock_guard lock(imageMutex);latestImage.reset();}
        if(window){SendMessageW(controlButton,BM_SETCHECK,BST_UNCHECKED,0);SendMessageW(gamepadButton,BM_SETCHECK,BST_UNCHECKED,0);EnableWindow(connectButton,TRUE);}
        if(canvas)InvalidateRect(canvas,nullptr,FALSE);
    }
    void Render(HDC dc){
        RECT client{};GetClientRect(canvas,&client);FillRect(dc,&client,static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
        const auto image=Image();
        if(image && !image->pixels.empty()){
            const RECT target=ImageRect(image.get());
            BITMAPINFO info{};info.bmiHeader.biSize=sizeof(BITMAPINFOHEADER);info.bmiHeader.biWidth=image->width;info.bmiHeader.biHeight=-LONG(image->height);info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;info.bmiHeader.biCompression=BI_RGB;
            SetStretchBltMode(dc,COLORONCOLOR);StretchDIBits(dc,target.left,target.top,target.right-target.left,target.bottom-target.top,0,0,image->width,image->height,image->pixels.data(),&info,DIB_RGB_COLORS,SRCCOPY);
        }
    }
    void Paint(){
        PAINTSTRUCT paint{};HDC dc=BeginPaint(canvas,&paint);
        RECT client{};GetClientRect(canvas,&client);
        if(frameSurface.Ensure(dc,client.right,client.bottom)){
            Render(frameSurface.Dc());
            if(frameSurface.Present(dc,paint.rcPaint))++bufferedPresents;
            else {++presentFailures;Render(dc);}
        }else if(client.right>0 && client.bottom>0){++presentFailures;Render(dc);}
        ++painted;
        EndPaint(canvas,&paint);
    }
    void Screenshot(){
        if(testScreenshot.empty() || !decoded)return;
        RECT rect{};GetWindowRect(window,&rect);HDC dc=GetDC(window),memory=CreateCompatibleDC(dc);
        HBITMAP bitmap=CreateCompatibleBitmap(dc,rect.right-rect.left,rect.bottom-rect.top);
        auto old=SelectObject(memory,bitmap);
        const int parentSaved=SaveDC(memory);
        SendMessageW(window,WM_PRINT,reinterpret_cast<WPARAM>(memory),PRF_NONCLIENT|PRF_CLIENT|PRF_CHILDREN|PRF_ERASEBKGND);
        RestoreDC(memory,parentSaved);
        POINT origin{};ClientToScreen(canvas,&origin);origin.x-=rect.left;origin.y-=rect.top;const int saved=SaveDC(memory);
        SetViewportOrgEx(memory,origin.x,origin.y,nullptr);Render(memory);RestoreDC(memory,saved);
        ULONG_PTR token=0;Gdiplus::GdiplusStartupInput startup;
        if(Gdiplus::GdiplusStartup(&token,&startup,nullptr)==Gdiplus::Ok){
            {Gdiplus::Bitmap image(bitmap,nullptr);CLSID png={0x557cf406,0x1a04,0x11d3,{0x9a,0x73,0x00,0x00,0xf8,0x1e,0xf3,0x2e}};
                if(image.Save(testScreenshot.c_str(),&png,nullptr)==Gdiplus::Ok)++offscreenRenders;}
            Gdiplus::GdiplusShutdown(token);
        }
        SelectObject(memory,old);DeleteObject(bitmap);DeleteDC(memory);ReleaseDC(window,dc);
    }
    void Fullscreen(){
        Unlock();Release();
        if(!fullscreen){GetWindowRect(window,&oldRect);oldStyle=GetWindowLongPtrW(window,GWL_STYLE);MONITORINFO monitor{sizeof(monitor)};GetMonitorInfoW(MonitorFromWindow(window,MONITOR_DEFAULTTONEAREST),&monitor);SetWindowLongPtrW(window,GWL_STYLE,WS_POPUP|WS_VISIBLE|WS_CLIPCHILDREN);SetWindowPos(window,HWND_TOP,monitor.rcMonitor.left,monitor.rcMonitor.top,monitor.rcMonitor.right-monitor.rcMonitor.left,monitor.rcMonitor.bottom-monitor.rcMonitor.top,SWP_FRAMECHANGED);}
        else{SetWindowLongPtrW(window,GWL_STYLE,oldStyle);SetWindowPos(window,nullptr,oldRect.left,oldRect.top,oldRect.right-oldRect.left,oldRect.bottom-oldRect.top,SWP_FRAMECHANGED|SWP_NOZORDER);}
        fullscreen=!fullscreen;SetFocus(canvas);
    }
    void Report(){
        auto [packets,drops]=audio.Stats();
        std::wstring status;{std::lock_guard lock(statusMutex);status=lastStatus;}
        Json value={{"received_frames",received.load()},{"decoded_frames",decoded.load()},{"paint_calls",painted.load()},
          {"video_queue_drops",queueDrops.load()},{"width",sourceWidth.load()},{"height",sourceHeight.load()},
          {"offscreen_renders",offscreenRenders},
          {"buffered_presents",bufferedPresents},{"present_failures",presentFailures},{"simulated_mouse_moves",simulatedMouseMoves},
          {"client_version",NativeClientVersion},{"presentation","GDI double buffer"},
          {"receive_fps",receiveFps.load()},{"decode_fps",decodeFps.load()},{"present_fps",presentFps.load()},
          {"waiting_keyframe_drops",waitingDrops.load()},{"recovery_requests",recoveryRequests.load()},{"decoder_resets",decoderResets.load()},
          {"last_decode_ms",decodeMs.load()},{"audio_packets",packets},{"audio_drops",drops},{"decoder","Media Foundation software baseline"},
          {"status",Utf8(status)},{"host_capture_pauses",capturePauses.load()},{"host_capture_resumes",captureResumes.load()},{"laptop_acceptance",false}};
        const auto path=testReport.empty()?settings.parent_path()/L"last-session.json":testReport;
        std::error_code error;std::filesystem::create_directories(path.parent_path(),error);
        std::ofstream(path)<<value.dump(2);
    }
};
static Client app;
struct ControlLayout {HWND window;int x,y,width,height;};
static std::vector<ControlLayout> layout;
static HFONT uiFont=nullptr;
static int Scale(HWND parent,int value){return MulDiv(value,GetDpiForWindow(parent),96);}

static LRESULT CALLBACK CanvasProc(HWND window,UINT message,WPARAM wParam,LPARAM lParam){
    switch(message){
    case WM_PAINT:app.Paint();return 0;
    case WM_PRINTCLIENT:app.Render(reinterpret_cast<HDC>(wParam));return 0;
    case FrameMessage:InvalidateRect(window,nullptr,FALSE);return 0;
    case WM_ERASEBKGND:return 1;
    case WM_SETCURSOR:if(LOWORD(lParam)==HTCLIENT){app.CanvasCursor();return TRUE;}break;
    case WM_MOUSEMOVE:app.Move(GET_X_LPARAM(lParam),GET_Y_LPARAM(lParam));return 0;
    case WM_LBUTTONDOWN:case WM_RBUTTONDOWN:case WM_MBUTTONDOWN:
        SetFocus(window);if(!app.locked){const auto rect=app.ImageRect();POINT point{GET_X_LPARAM(lParam),GET_Y_LPARAM(lParam)};if(!PtInRect(&rect,point))return 0;
            app.Move(point.x,point.y,true);app.Button(message==WM_LBUTTONDOWN?0:message==WM_RBUTTONDOWN?2:1,true);SetCapture(window);}return 0;
    case WM_LBUTTONUP:case WM_RBUTTONUP:case WM_MBUTTONUP:
        if(!app.locked){app.Button(message==WM_LBUTTONUP?0:message==WM_RBUTTONUP?2:1,false);ReleaseCapture();}return 0;
    case WM_MOUSEWHEEL:if(!app.locked && app.controlReady && app.controlRequested)app.Input({{"type","wheel"},{"delta",GET_WHEEL_DELTA_WPARAM(wParam)}});return 0;
    case WM_KILLFOCUS:app.Unlock();app.Release();app.NeutralGamepad();return 0;
    case WM_CAPTURECHANGED:app.Unlock();app.Release();return 0;
    case WM_KEYDOWN:case WM_SYSKEYDOWN:case WM_KEYUP:case WM_SYSKEYUP:return 0;
    case WM_CHAR:case WM_SYSCHAR:return 0;
    case WM_INPUT:app.Raw(reinterpret_cast<HRAWINPUT>(lParam));break;
    }
    return DefWindowProcW(window,message,wParam,lParam);
}
static HWND Child(HWND parent,const wchar_t* kind,const wchar_t* text,DWORD style,int x,int y,int w,int h,int id=0){
    const DWORD tab=std::wstring(kind)==L"STATIC"?0:WS_TABSTOP;
    auto control=CreateWindowExW(0,kind,text,WS_CHILD|WS_VISIBLE|style|tab,Scale(parent,x),Scale(parent,y),Scale(parent,w),Scale(parent,h),parent,reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),GetModuleHandleW(nullptr),nullptr);
    SendMessageW(control,WM_SETFONT,reinterpret_cast<WPARAM>(uiFont),TRUE);layout.push_back({control,x,y,w,h});return control;
}
static LRESULT CALLBACK WindowProc(HWND window,UINT message,WPARAM wParam,LPARAM lParam){
    switch(message){
    case WM_CREATE:{app.window=window;
        uiFont=CreateFontW(-MulDiv(11,GetDpiForWindow(window),72),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft JhengHei UI");
        Child(window,L"STATIC",L"主機 HTTPS 網址",0,12,12,130,22);
        app.urlField=Child(window,L"EDIT",L"",WS_BORDER|ES_AUTOHSCROLL,140,10,435,26);
        Child(window,L"STATIC",L"配對碼",0,585,12,65,22);
        app.codeField=Child(window,L"EDIT",L"",WS_BORDER|ES_PASSWORD|ES_AUTOHSCROLL,650,10,105,26);SendMessageW(app.codeField,EM_SETLIMITTEXT,8,0);
        app.connectButton=Child(window,L"BUTTON",L"連線",BS_PUSHBUTTON,768,9,75,28,ConnectId);
        Child(window,L"BUTTON",L"斷線",BS_PUSHBUTTON,850,9,75,28,DisconnectId);
        Child(window,L"STATIC",L"信任的 CA 憑證",0,12,48,130,22);
        app.caField=Child(window,L"EDIT",L"",WS_BORDER|ES_AUTOHSCROLL,140,44,435,26);
        Child(window,L"BUTTON",L"選擇 .crt",BS_PUSHBUTTON,585,43,105,28,TrustId);
        app.modeField=Child(window,L"COMBOBOX",L"",CBS_DROPDOWNLIST,700,44,225,200);
        SendMessageW(app.modeField,CB_ADDSTRING,0,reinterpret_cast<LPARAM>(L"1080p 日常"));SendMessageW(app.modeField,CB_ADDSTRING,0,reinterpret_cast<LPARAM>(L"2K 清晰（2560×1440）"));SendMessageW(app.modeField,CB_SETCURSEL,0,0);
        app.controlButton=Child(window,L"BUTTON",L"啟用遠端操作",BS_AUTOCHECKBOX,12,80,150,28,ControlId);
        app.mouseButton=Child(window,L"BUTTON",L"遊戲滑鼠",BS_PUSHBUTTON,170,79,145,28,MouseId);
        Child(window,L"BUTTON",L"全螢幕",BS_PUSHBUTTON,325,79,100,28,FullId);
        app.audioButton=Child(window,L"BUTTON",L"播放聲音",BS_AUTOCHECKBOX,445,80,120,28,AudioId);SendMessageW(app.audioButton,BM_SETCHECK,BST_CHECKED,0);
        app.gamepadButton=Child(window,L"BUTTON",L"XInput 手把",BS_AUTOCHECKBOX,585,80,135,28,GamepadId);
        Child(window,L"STATIC",L"點畫面聚焦；Esc 釋放滑鼠。",0,730,84,220,22);
        app.canvas=Child(window,L"RemoteDeskCanvas",L"",WS_TABSTOP,0,118,960,450);
        app.statusField=Child(window,L"STATIC",L"尚未連線；CA 留空時使用 Windows 憑證信任。",0,12,575,936,28);
        RAWINPUTDEVICE devices[]={{1,2,0,app.canvas},{1,6,0,app.canvas}};
        if(!RegisterRawInputDevices(devices,2,sizeof(RAWINPUTDEVICE)))app.Status(L"無法註冊原生鍵鼠輸入");
        app.Load();SetTimer(window,1,1000,nullptr);SetTimer(window,2,8,nullptr);return 0;
    }
    case WM_SIZE:{RECT rect{};GetClientRect(window,&rect);MoveWindow(app.canvas,0,Scale(window,118),rect.right,std::max<LONG>(0,rect.bottom-Scale(window,156)),TRUE);MoveWindow(app.statusField,Scale(window,12),std::max<LONG>(Scale(window,118),rect.bottom-Scale(window,32)),std::max<LONG>(0,rect.right-Scale(window,24)),Scale(window,28),TRUE);if(app.locked)app.Unlock();return 0;}
    case WM_GETMINMAXINFO:reinterpret_cast<MINMAXINFO*>(lParam)->ptMinTrackSize={Scale(window,1000),Scale(window,600)};return 0;
    case WM_DPICHANGED:{
        const auto oldFont=uiFont;uiFont=CreateFontW(-MulDiv(11,HIWORD(wParam),72),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Microsoft JhengHei UI");
        for(const auto& item:layout){SendMessageW(item.window,WM_SETFONT,reinterpret_cast<WPARAM>(uiFont),TRUE);if(item.window!=app.canvas && item.window!=app.statusField)MoveWindow(item.window,Scale(window,item.x),Scale(window,item.y),Scale(window,item.width),Scale(window,item.height),TRUE);}
        auto* rect=reinterpret_cast<RECT*>(lParam);SetWindowPos(window,nullptr,rect->left,rect->top,rect->right-rect->left,rect->bottom-rect->top,SWP_NOZORDER|SWP_NOACTIVATE);if(oldFont)DeleteObject(oldFont);return 0;}
    case StatusMessage:{{std::lock_guard lock(app.statusMutex);SetWindowTextW(app.statusField,app.lastStatus.c_str());}app.RefreshLocalCursor();return 0;}
    case FinishedMessage:if(wParam==app.generation){app.Report();app.Unlock();app.Release();app.controlRequested=false;SendMessageW(app.controlButton,BM_SETCHECK,BST_UNCHECKED,0);EnableWindow(app.connectButton,TRUE);app.RefreshLocalCursor();}return 0;
    case WM_ACTIVATE:if(LOWORD(wParam)==WA_INACTIVE){app.Unlock();app.Release();app.NeutralGamepad();SetCursor(LoadCursorW(nullptr,IDC_ARROW));}else app.RefreshLocalCursor();return 0;
    case WM_COMMAND:switch(LOWORD(wParam)){
        case ConnectId:app.Start();return 0;
        case DisconnectId:app.Report();app.Stop();app.Status(L"已斷線");return 0;
        case ControlId:app.Release();app.controlRequested=SendMessageW(app.controlButton,BM_GETCHECK,0,0)==BST_CHECKED;
            if(!app.running){app.controlRequested=false;SendMessageW(app.controlButton,BM_SETCHECK,BST_UNCHECKED,0);app.Status(L"請先連線");return 0;}
            if(!app.controlRequested)app.Unlock();app.Send({{"type","set-control"},{"enabled",app.controlRequested.load()}});SetFocus(app.canvas);app.RefreshLocalCursor();return 0;
        case MouseId:if(app.locked)app.Unlock();else app.Lock();return 0;
        case FullId:app.Fullscreen();return 0;
        case AudioId:app.audio.SetEnabled(SendMessageW(app.audioButton,BM_GETCHECK,0,0)==BST_CHECKED);return 0;
        case GamepadId:
            app.NeutralGamepad();app.gamepadRequested=SendMessageW(app.gamepadButton,BM_GETCHECK,0,0)==BST_CHECKED;
            if(!app.controlReady){app.gamepadRequested=false;SendMessageW(app.gamepadButton,BM_SETCHECK,BST_UNCHECKED,0);app.Status(L"請先啟用遠端操作");return 0;}
            app.Send({{"type","set-gamepad"},{"enabled",app.gamepadRequested}});SetFocus(app.canvas);return 0;
        case TrustId:{wchar_t file[MAX_PATH]{};OPENFILENAMEW picker{sizeof(picker)};picker.hwndOwner=window;picker.lpstrFilter=L"CA 憑證 (*.crt;*.pem;*.cer)\0*.crt;*.pem;*.cer\0\0";picker.lpstrFile=file;picker.nMaxFile=MAX_PATH;picker.Flags=OFN_FILEMUSTEXIST|OFN_PATHMUSTEXIST;
            if(GetOpenFileNameW(&picker))SetWindowTextW(app.caField,file);return 0;}
        }break;
    case WM_TIMER:{
        if(wParam==2){
            app.PollInput();
            if(app.testMode && app.testMouseRepaint && app.running){
                ++app.simulatedMouseMoves;
                SendMessageW(app.canvas,WM_MOUSEMOVE,0,MAKELPARAM(20+app.simulatedMouseMoves%700,100));
                InvalidateRect(app.canvas,nullptr,FALSE);
            }
            return 0;
        }
        if(app.running){const double seconds=std::chrono::duration<double>(Clock::now()-app.started).count();
            const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
            if(!app.hostCapturePaused && app.lastVideoAt && now-app.lastVideoAt>1500)app.RequestRecovery();
            if(int(seconds)%2==0){
                auto [received,lost]=app.feedback->Stats();std::shared_ptr<rtc::PeerConnection> connection;
                {std::lock_guard lock(app.peerMutex);connection=app.peer;}
                Json report={{"type","network-feedback"},{"received",received},{"lost",lost},{"nacks",0},{"rttMs",nullptr}};
                if(connection){auto rtt=connection->rtt();if(rtt)report["rttMs"]=rtt->count();}
                if(received)app.Send(report);
            }
            const auto rateNow=Clock::now();const double elapsed=std::chrono::duration<double>(rateNow-app.lastRateAt).count();
            if(elapsed>0){
                const auto received=app.received.load(),decoded=app.decoded.load(),painted=app.painted.load();
                app.receiveFps=(received-app.rateReceived)/elapsed;app.decodeFps=(decoded-app.rateDecoded)/elapsed;app.presentFps=(painted-app.ratePainted)/elapsed;
                app.rateReceived=received;app.rateDecoded=decoded;app.ratePainted=painted;app.lastRateAt=rateNow;
            }
            const std::wstring title=L"RemoteDesk Windows "+Wide(NativeClientVersion)+L" · "+std::to_wstring(app.sourceWidth.load())+L"×"+std::to_wstring(app.sourceHeight.load())+
              L" · 接收 "+std::to_wstring(int(app.receiveFps))+L"／解碼 "+std::to_wstring(int(app.decodeFps))+L"／重畫 "+std::to_wstring(int(app.presentFps))+L" FPS · 解碼 "+std::to_wstring(int(app.decodeMs))+L" ms · 丟棄 "+std::to_wstring(app.queueDrops+app.waitingDrops)+L" · 軟體解碼";SetWindowTextW(window,title.c_str());
        }
        if(app.testMode && app.testSeconds>0 && std::chrono::duration<double>(Clock::now()-app.started).count()>=app.testSeconds){app.Screenshot();app.Report();PostMessageW(window,WM_CLOSE,0,0);}return 0;}
    case WM_CLOSE:app.Report();app.Stop();DestroyWindow(window);return 0;
    case WM_DESTROY:if(uiFont){DeleteObject(uiFont);uiFont=nullptr;}PostQuitMessage(0);return 0;
    }
    return DefWindowProcW(window,message,wParam,lParam);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,LPWSTR,int show){
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    int argc=0;auto argv=CommandLineToArgvW(GetCommandLineW(),&argc);std::map<std::wstring,std::wstring> arguments;
    for(int i=1;i<argc;++i){std::wstring arg=argv[i];auto separator=arg.find(L'=');arguments[arg.substr(0,separator)]=separator==std::wstring::npos?L"":arg.substr(separator+1);}LocalFree(argv);
    if(arguments.contains(L"--self-test")){
        try{if(NativeUrl::Parse(L"https://192.168.1.1:10433/?client=pc").port!=10433)return 1;
            for(const auto* bad:{L"http://host/",L"https://user:pass@host/",L"https://host/evil",L"file:///C:/"}){bool rejected=false;try{NativeUrl::Parse(bad);}catch(...){rejected=true;}if(!rejected)return 2;}
            RAWKEYBOARD left{};left.VKey=VK_SHIFT;left.MakeCode=0x2a;RAWKEYBOARD right=left;right.MakeCode=0x36;
            if(KeyCode(left)!="ShiftLeft" || KeyCode(right)!="ShiftRight")return 3;
            rtc::binary nal={std::byte{0},std::byte{0},std::byte{0},std::byte{1},std::byte{0x65},std::byte{0}};if(!Keyframe(nal))return 4;
            ReceiverFeedback counter;counter.Count(65534);counter.Count(0);if(counter.Stats()!=std::pair<uint64_t,uint64_t>{2,1})return 6;
            counter.Count(65535);counter.Count(65535);if(counter.Stats()!=std::pair<uint64_t,uint64_t>{3,0})return 7;
            return 0;}catch(...){return 5;}
    }
    wchar_t local[MAX_PATH]{};SHGetFolderPathW(nullptr,CSIDL_LOCAL_APPDATA,nullptr,SHGFP_TYPE_CURRENT,local);
    app.settings=arguments.contains(L"--settings")?std::filesystem::path(arguments[L"--settings"]):std::filesystem::path(local)/L"RemoteDesk"/L"PC"/L"settings.json";
    WNDCLASSW canvas{};canvas.lpfnWndProc=CanvasProc;canvas.hInstance=instance;canvas.lpszClassName=L"RemoteDeskCanvas";canvas.hCursor=LoadCursorW(nullptr,IDC_ARROW);RegisterClassW(&canvas);
    WNDCLASSW window{};window.lpfnWndProc=WindowProc;window.hInstance=instance;window.lpszClassName=L"RemoteDeskWindows";window.hCursor=LoadCursorW(nullptr,IDC_ARROW);window.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_BTNFACE+1);RegisterClassW(&window);
    const std::wstring initialTitle=L"RemoteDesk Windows "+Wide(NativeClientVersion);
    auto handle=CreateWindowExW(0,window.lpszClassName,initialTitle.c_str(),WS_OVERLAPPEDWINDOW|WS_CLIPCHILDREN,CW_USEDEFAULT,CW_USEDEFAULT,MulDiv(1100,GetDpiForSystem(),96),MulDiv(760,GetDpiForSystem(),96),nullptr,nullptr,instance,nullptr);
    if(!handle)return 10;
    ShowWindow(handle,show);UpdateWindow(handle);
    if(arguments.contains(L"--test-url")){
        app.testMode=true;app.testSeconds=arguments.contains(L"--test-seconds")?std::stoi(arguments[L"--test-seconds"]):15;
        app.testMouseRepaint=arguments.contains(L"--test-mouse-repaint");
        if(arguments.contains(L"--test-decode-delay-ms"))app.testDecodeDelayMs=std::clamp(std::stoi(arguments[L"--test-decode-delay-ms"]),0,200);
        SetWindowDisplayAffinity(handle,WDA_EXCLUDEFROMCAPTURE);
        // Render the test window outside the desktop, without focus or a taskbar entry.
        SetWindowLongPtrW(handle,GWL_EXSTYLE,GetWindowLongPtrW(handle,GWL_EXSTYLE)|WS_EX_TOOLWINDOW);
        SetWindowPos(handle,nullptr,-20000,-20000,0,0,SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOZORDER);
        ShowWindow(handle,SW_SHOWNOACTIVATE);
        if(arguments.contains(L"--test-no-audio"))SendMessageW(app.audioButton,BM_SETCHECK,BST_UNCHECKED,0);
        app.testReport=arguments[L"--test-report"];app.testScreenshot=arguments[L"--test-screenshot"];SetWindowTextW(app.urlField,arguments[L"--test-url"].c_str());SetWindowTextW(app.codeField,arguments[L"--test-code"].c_str());SetWindowTextW(app.caField,arguments[L"--test-ca"].c_str());app.Start();
    }
    MSG message{};while(GetMessageW(&message,nullptr,0,0)>0){if(!(app.controlRequested && GetFocus()==app.canvas) && IsDialogMessageW(handle,&message))continue;TranslateMessage(&message);DispatchMessageW(&message);}
    app.window=nullptr;CoUninitialize();return 0;
}
