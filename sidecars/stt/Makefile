##
## jarvis STT sidecar — whisper.cpp with CoreML (ANE) + Metal fallback
##
## make          build whisper.cpp (clone if needed)
## make model    download ggml-base.en
## make coreml   generate the CoreML/ANE encoder (multi-minute; separate venv)
## make status   show build status
##
## Appendix A fix baked in: WHISPER_COREML_ALLOW_FALLBACK=1 — without it a
## missing .mlmodelc is FATAL instead of falling back to Metal.
##

WHISPER_DIR  := whisper.cpp
SERVER_BIN   := $(WHISPER_DIR)/build/bin/whisper-server
WHISPER_REPO := https://github.com/ggml-org/whisper.cpp
MODEL        := base.en
MODEL_FILE   := models/ggml-$(MODEL).bin
COREML_DIR   := $(WHISPER_DIR)/models/ggml-$(MODEL)-encoder.mlmodelc
JOBS ?= $(shell sysctl -n hw.ncpu 2>/dev/null || echo 4)

.PHONY: all build model coreml status clean nuke

all: build model

$(WHISPER_DIR)/.git:
	git clone --depth 1 $(WHISPER_REPO) $(WHISPER_DIR)

build: $(WHISPER_DIR)/.git
	cd $(WHISPER_DIR) && cmake -B build \
		-DWHISPER_COREML=1 \
		-DWHISPER_COREML_ALLOW_FALLBACK=1 \
		-DCMAKE_BUILD_TYPE=Release
	cd $(WHISPER_DIR) && cmake --build build -j$(JOBS) --config Release
	@test -f "$(SERVER_BIN)" && echo "✓ whisper-server built" || (echo "✗ build failed"; exit 1)

model:
	@mkdir -p models
	@if [ ! -f "$(MODEL_FILE)" ]; then \
		cd $(WHISPER_DIR)/models && bash download-ggml-model.sh $(MODEL) && \
		cp ggml-$(MODEL).bin ../../models/; \
	fi
	@echo "✓ model: $(MODEL_FILE)"

# The ANE encoder is a separate generation step the plain build does NOT produce;
# the latency budget's 0.3s transcript line assumes it (design: voice ports).
coreml: $(WHISPER_DIR)/.git
	@if [ -d "$(COREML_DIR)" ]; then echo "✓ CoreML encoder already generated"; exit 0; fi
	uv venv --python 3.11 .venv-coreml
	uv pip install --python .venv-coreml/bin/python \
		"coremltools>=7" "openai-whisper" "ane_transformers" "torch" "setuptools<81"
	cd $(WHISPER_DIR) && PATH="$(CURDIR)/.venv-coreml/bin:$$PATH" \
		bash models/generate-coreml-model.sh $(MODEL)
	@test -d "$(COREML_DIR)" && echo "✓ CoreML encoder generated (ANE active on next start)" \
		|| (echo "✗ CoreML generation failed — Metal fallback remains in effect"; exit 1)

status:
	@echo "binary:  $$( [ -f $(SERVER_BIN) ] && echo ok || echo missing )"
	@echo "model:   $$( [ -f $(MODEL_FILE) ] && echo ok || echo missing )"
	@echo "coreml:  $$( [ -d $(COREML_DIR) ] && echo ok '(ANE)' || echo missing '(Metal fallback)' )"

clean:
	rm -rf $(WHISPER_DIR)/build

nuke:
	rm -rf $(WHISPER_DIR) .venv-coreml
