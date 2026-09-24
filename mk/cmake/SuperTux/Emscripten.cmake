set(CMAKE_EXECUTABLE_SUFFIX .html)
set(IS_EMSCRIPTEN_BUILD ON)
set(SQ_DISABLE_INSTALLER YES)
set(SSQ_BUILD_INSTALL NO)

set(EM_USE_FLAGS "-sDISABLE_EXCEPTION_CATCHING=0 -sUSE_SDL=3 -sUSE_SDL_IMAGE=3 -sUSE_SDL_TTF=3 -sUSE_VORBIS=1 -fPIC")
# --use-preload-cache keeps the data package in IndexedDB, so the ~330 MB are
# downloaded once per build instead of on every start (browsers don't keep a
# file this large in their HTTP cache).
set(EM_LINK_FLAGS " -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=536870912 -sERROR_ON_UNDEFINED_SYMBOLS=0 --preload-file ${BUILD_CONFIG_DATA_DIR} --use-preload-cache -lidbfs.js")
if(ENABLE_OPENGL)
  set(EM_LINK_FLAGS "${EM_LINK_FLAGS} -sFULL_ES2")
  set(HAVE_OPENGL ON CACHE BOOL "")
  set(USE_OPENGLES2 ON CACHE BOOL "")
endif()

if(CMAKE_BUILD_TYPE MATCHES Debug)
  set(EM_USE_FLAGS "${EM_USE_FLAGS} -fsanitize=undefined")
  set(EM_LINK_FLAGS "${EM_LINK_FLAGS} -fsanitize=undefined -sSAFE_HEAP=1 -sASSERTIONS=1")
endif()
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${EM_USE_FLAGS} ${EM_C_FLAGS}")
if(CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  string(APPEND CMAKE_CXX_FLAGS " -Wno-lifetime-safety-intra-tu-suggestions")
endif()
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${EM_USE_FLAGS} ${EM_C_FLAGS}")
set(CMAKE_LINKER_FLAGS "${CMAKE_LINKER_FLAGS} ${EM_USE_FLAGS} ${EM_LINK_FLAGS}")
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_LINKER_FLAGS} ${EM_USE_FLAGS} ${EM_LINK_FLAGS}")

add_library(OpenAL INTERFACE IMPORTED)
set_target_properties(OpenAL PROPERTIES
  INTERFACE_INCLUDE_DIRECTORIES "${PROJECT_SOURCE_DIR}/mk/emscripten/AL"
  INTERFACE_LINK_LIBRARIES "-lopenal"
)

# Emscripten has no SDL3_image port (-sUSE_SDL_IMAGE=3 is a no-op), so link the
# static library from the toolchain prefix (e.g. vcpkg) against the SDL3 port.
find_library(SDL3_IMAGE_LIBRARY NAMES SDL3_image REQUIRED)
find_package(JPEG REQUIRED)
add_library(SDL3_image INTERFACE IMPORTED)
set_target_properties(SDL3_image PROPERTIES
  INTERFACE_LINK_LIBRARIES "${SDL3_IMAGE_LIBRARY};JPEG::JPEG;PNG"
)
