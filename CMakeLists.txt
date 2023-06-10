cmake_minimum_required(VERSION 3.25)

project(bare_http1 C)

include(bare)

add_bare_module(bare_http1)

target_sources(
  bare_http1
  PRIVATE
    binding.c
)
