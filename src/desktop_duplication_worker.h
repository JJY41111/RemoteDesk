#pragma once
#include "system_channel.h"
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace remotedesk {
// Own DXGI duplication on a window-free thread attached to the current input
// desktop. Recreate this worker after a desktop transition. Encoding and TCP
// remain alive, so the receiver need not reconnect or re-pair.
class DesktopDuplicationWorker {
    enum class Operation { None, Acquire, Release, Stop };
    std::mutex mutex_;
    std::condition_variable changed_;
    Operation operation_=Operation::None;
    bool completed_=false;
    HRESULT result_=E_PENDING;
    UINT timeout_{};
    DXGI_OUTDUPL_FRAME_INFO* frame_{};
    IDXGIResource** resource_{};
    std::thread thread_;

    void Run(IDXGIOutput1* output, ID3D11Device* device) noexcept {
        InputDesktop desktop;
        Microsoft::WRL::ComPtr<IDXGIOutputDuplication> duplication;
        HRESULT result=desktop.Follow()?S_OK:HRESULT_FROM_WIN32(GetLastError());
        const HRESULT com=SUCCEEDED(result)?CoInitializeEx(nullptr,COINIT_MULTITHREADED):E_FAIL;
        if(SUCCEEDED(result) && FAILED(com))result=com;
        if(SUCCEEDED(result))result=output->DuplicateOutput(device,&duplication);
        std::unique_lock lock(mutex_);
        result_=result;completed_=true;changed_.notify_all();
        bool acquired=false;
        for(;;) {
            changed_.wait(lock,[&]{return operation_!=Operation::None;});
            const auto operation=operation_;
            if(operation==Operation::Stop)break;
            lock.unlock();
            if(!duplication)result=E_UNEXPECTED;
            else if(operation==Operation::Acquire) {
                result=duplication->AcquireNextFrame(timeout_,frame_,resource_);
                acquired=SUCCEEDED(result);
            } else {
                result=acquired?duplication->ReleaseFrame():DXGI_ERROR_INVALID_CALL;
                acquired=false;
            }
            lock.lock();result_=result;operation_=Operation::None;
            completed_=true;changed_.notify_all();
        }
        lock.unlock();
        if(acquired)duplication->ReleaseFrame();
        duplication.Reset();
        if(SUCCEEDED(com))CoUninitialize();
    }
    HRESULT Invoke(Operation operation) {
        std::unique_lock lock(mutex_);
        completed_=false;operation_=operation;changed_.notify_all();
        changed_.wait(lock,[&]{return completed_;});return result_;
    }
public:
    DesktopDuplicationWorker(IDXGIOutput1* output,ID3D11Device* device)
        :thread_([this,output,device]{Run(output,device);}){}
    DesktopDuplicationWorker(const DesktopDuplicationWorker&)=delete;
    DesktopDuplicationWorker& operator=(const DesktopDuplicationWorker&)=delete;
    ~DesktopDuplicationWorker() {
        {std::lock_guard lock(mutex_);operation_=Operation::Stop;changed_.notify_all();}
        thread_.join();
    }
    HRESULT Ready() {
        std::unique_lock lock(mutex_);
        changed_.wait(lock,[&]{return completed_;});return result_;
    }
    HRESULT Acquire(UINT timeout,DXGI_OUTDUPL_FRAME_INFO* frame,IDXGIResource** resource) {
        timeout_=timeout;frame_=frame;resource_=resource;
        return Invoke(Operation::Acquire);
    }
    HRESULT Release(){return Invoke(Operation::Release);}
};
}
