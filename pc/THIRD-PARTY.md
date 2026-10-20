# Third-party components

The native client links libdatachannel v0.24.5 (MPL-2.0), Mbed TLS 3.6.7 LTS (Apache-2.0 or GPL-2.0-or-later as offered upstream), and Opus v1.5.2 (BSD license). It also uses libdatachannel's pinned libjuice, libsrtp, usrsctp, plog and nlohmann/json dependencies. Their upstream license texts are included under `licenses/`.

Corresponding source is available from the original projects and from the exact revisions documented in `docs/windows-client-2026-10-13.md`. No libdatachannel source files are modified. Mbed TLS's documented `MBEDTLS_SSL_DTLS_SRTP` configuration switch is enabled by `build-client.ps1`.

Microsoft Visual C++ Runtime DLLs are the app-local redistributable binaries supplied with the installed, licensed Visual Studio development environment. Their use is governed by Microsoft's Visual Studio redistribution terms. Windows system components are not bundled.

RemoteDesk source: https://github.com/JJY41111/RemoteDesk (repository availability is governed by its owner's access settings).
