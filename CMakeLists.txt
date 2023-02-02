cmake_minimum_required(VERSION 3.25)

project(pear_http C)

include(pear)

add_pear_module(pear_http)

target_sources(
  pear_http
  PRIVATE
    binding.c
)
