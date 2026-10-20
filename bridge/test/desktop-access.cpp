#include <windows.h>
#include <iostream>
#include <thread>
// Does not switch the visible desktop or press a key/button. Compare the access
// used by the old helper with the complete input-desktop handle on fresh threads.
int main() {
    for(const DWORD access:{DWORD(DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS|
        DESKTOP_SWITCHDESKTOP|DESKTOP_CREATEWINDOW),DWORD(GENERIC_ALL)}) {
        std::thread probe([access]{
            HDESK original=GetThreadDesktop(GetCurrentThreadId());
            HDESK desktop=OpenInputDesktop(0,FALSE,access);
            if(!desktop){std::cout<<access<<" open_error="<<GetLastError()<<'\n';return;}
            if(!SetThreadDesktop(desktop)){
                std::cout<<access<<" attach_error="<<GetLastError()<<'\n';CloseDesktop(desktop);return;
            }
            INPUT input{};input.type=INPUT_MOUSE;input.mi.dwFlags=MOUSEEVENTF_MOVE;
            SetLastError(0);const UINT sent=SendInput(1,&input,sizeof(input));
            const DWORD error=GetLastError();
            std::cout<<"access="<<access<<" sent="<<sent<<" error="<<error<<'\n';
            SetThreadDesktop(original);CloseDesktop(desktop);
        });probe.join();
    }
}
