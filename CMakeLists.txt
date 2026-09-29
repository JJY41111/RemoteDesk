cmake_minimum_required(VERSION 3.20)

project(RemoteDesk VERSION 0.1.0 LANGUAGES CXX)

add_executable(remote_desk WIN32
    src/h264_loopback.cpp
    src/h264_recorder.cpp
    src/main.cpp
    src/network_transport.cpp
)

add_executable(remote_desk_receiver
    src/h264_network_decoder.cpp
    src/network_transport.cpp
    src/receiver_main.cpp
)
add_executable(remote_desk_input src/remote_input.cpp)
add_executable(remote_desk_audio src/audio_loopback.cpp)
target_compile_features(remote_desk_input PRIVATE cxx_std_20)
target_compile_features(remote_desk_audio PRIVATE cxx_std_20)
target_compile_definitions(remote_desk_input PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
)
target_link_libraries(remote_desk_input PRIVATE user32 dxgi)
target_compile_definitions(remote_desk_audio PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
)
target_link_libraries(remote_desk_audio PRIVATE ole32 mmdevapi user32)
target_compile_features(remote_desk_receiver PRIVATE cxx_std_20)
target_compile_definitions(remote_desk_receiver PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)
target_link_libraries(remote_desk_receiver PRIVATE
    gdi32
    mf
    mfplat
    mfreadwrite
    mfuuid
    ole32
    oleaut32
    user32
    wmcodecdspuuid
    ws2_32
)

target_compile_features(remote_desk PRIVATE cxx_std_20)
target_compile_definitions(remote_desk PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)

target_link_libraries(remote_desk PRIVATE
    d3d11
    dxgi
    gdi32
    mf
    mfplat
    mfreadwrite
    mfuuid
    oleaut32
    user32
    wmcodecdspuuid
    ws2_32
)

if(MSVC)
    target_compile_options(remote_desk PRIVATE /W4 /permissive- /EHsc)
    target_compile_options(remote_desk_receiver PRIVATE /W4 /permissive- /EHsc)
    target_compile_options(remote_desk_input PRIVATE /W4 /permissive- /EHsc)
    target_compile_options(remote_desk_audio PRIVATE /W4 /permissive- /EHsc)
endif()
