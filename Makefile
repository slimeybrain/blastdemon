# BlastDaemon Ultra-Fast Root Makefile
# Automatically harnesses ccache, parallel cores, and streamlined target scoping

BUILD_DIR ?= build
MAX_JOBS ?= 4
NPROC ?= $(shell nproc 2>/dev/null || echo 4)
JOBS ?= $(shell echo $$(( $(NPROC) > $(MAX_JOBS) ? $(MAX_JOBS) : $(NPROC) )))

.PHONY: all default clean frontend verify tests help

# Default target builds primary production deliverables in parallel
default:
	@cmake -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release
	@cmake --build $(BUILD_DIR) -j $(JOBS)

all: default

# Direct target aliases (e.g. `make BlastSolver`, `make Broker`, `make blastcli`, `make blast_verify`)
Broker BlastSolver blastcli BlastStudio blast_verify:
	@cmake -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release
	@cmake --build $(BUILD_DIR) --target $@ -j $(JOBS)

# Living Verification Compendium execution
verify: blast_verify
	@./$(BUILD_DIR)/blast_verify

# Standalone test targets (built on demand without polluting standard build times)
tests all_tests:
	@cmake -B $(BUILD_DIR) -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=ON
	@cmake --build $(BUILD_DIR) --target all_tests -j $(NPROC)

# Frontend incremental production build
frontend:
	@npm --prefix frontend run build

# Clean build directory and caches
clean:
	@rm -rf $(BUILD_DIR)

help:
	@echo "BlastDaemon Build Commands:"
	@echo "  make              - Build core production binaries (Broker, BlastSolver, blastcli, blast_verify)"
	@echo "  make BlastSolver  - Build worker solver executable"
	@echo "  make Broker       - Build telemetry & WebSocket daemon"
	@echo "  make verify       - Compile and execute headless living verification test suite"
	@echo "  make tests        - Build standalone benchmark executables (on demand)"
	@echo "  make frontend     - Compile and bundle frontend UI assets"
	@echo "  make clean        - Remove build artifacts"
