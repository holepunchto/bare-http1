cmake_minimum_required(VERSION 3.25)

project(bare_http C)

include(bare)

add_bare_module(bare_http)

target_sources(
  bare_http
  PRIVATE
    binding.c
)
