#include "network_transport.h"

#include <fstream>
#include <iostream>
#include <stdexcept>

int main() {
    try {
        const auto statistics = remotedesk::ReceiveLoopbackPackets(5000);
        std::ofstream log("receiver.log", std::ios::trunc);
        log << "received=" << statistics.packets << ", bytes="
            << statistics.bytes << ", checksum=" << statistics.checksum << '\n';
        std::cout << "received=" << statistics.packets << ", bytes="
                  << statistics.bytes << ", checksum=" << statistics.checksum
                  << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "receiver error: " << error.what() << '\n';
        return 1;
    }
}
