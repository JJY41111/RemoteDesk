#include "../../src/desktop_duplication_worker.h"
#include <iostream>
using Microsoft::WRL::ComPtr;
int main() {
    ComPtr<IDXGIFactory1> factory;ComPtr<IDXGIAdapter1> adapter;
    ComPtr<IDXGIOutput> output;ComPtr<IDXGIOutput1> output1;
    ComPtr<ID3D11Device> device;ComPtr<ID3D11DeviceContext> context;
    if(FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))||
       FAILED(factory->EnumAdapters1(0,&adapter))||FAILED(adapter->EnumOutputs(0,&output))||
       FAILED(output.As(&output1))||FAILED(D3D11CreateDevice(adapter.Get(),D3D_DRIVER_TYPE_UNKNOWN,
       nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&device,nullptr,&context)))return 1;
    unsigned frames=0;
    for(unsigned cycle=0;cycle<3;cycle++) {
        remotedesk::DesktopDuplicationWorker worker(output1.Get(),device.Get());
        const HRESULT ready=worker.Ready();
        if(FAILED(ready)){std::cerr<<"Ready failed "<<std::hex<<ready<<'\n';return 2;}
        for(unsigned i=0;i<30;i++) {
            DXGI_OUTDUPL_FRAME_INFO info{};ComPtr<IDXGIResource> resource;
            HRESULT result=worker.Acquire(16,&info,&resource);
            if(result==DXGI_ERROR_WAIT_TIMEOUT)continue;
            if(FAILED(result)||!resource)return 3;
            ComPtr<ID3D11Texture2D> frame;if(FAILED(resource.As(&frame)))return 4;
            D3D11_TEXTURE2D_DESC description{};frame->GetDesc(&description);
            if(!description.Width||!description.Height)return 5;
            if(FAILED(worker.Release()))return 6;
            ++frames;
        }
        std::cout<<"worker lifecycle "<<cycle+1<<" completed\n";
    }
    if(!frames)return 7;
    std::cout<<"PASS actual DXGI frames="<<frames<<"; no UAC acceptance claimed\n";
}
