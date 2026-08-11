.DEFAULT_GOAL := help

POWERSHELL ?= powershell
BUILD := $(POWERSHELL) -NoProfile -ExecutionPolicy Bypass -File ./build.ps1

.PHONY: help check server exe all release clean

help:
	@$(BUILD) help

check:
	@$(BUILD) check

server:
	@$(BUILD) server

exe:
	@$(BUILD) exe

all:
	@$(BUILD) all

release:
	@$(BUILD) release

clean:
	@$(BUILD) clean
