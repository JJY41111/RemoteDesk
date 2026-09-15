cmake_minimum_required(VERSION 3.20)

project(RemoteDesk VERSION 0.1.0 LANGUAGES CXX)

add_executable(remote_desk WIN32
    src/h264_recorder.cpp
    src/main.cpp
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
    mf
    mfplat
    mfreadwrite
    mfuuid
)

if(MSVC)
    target_compile_options(remote_desk PRIVATE /W4 /permissive- /EHsc)
endif()
