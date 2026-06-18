<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { BasePoint } from "../../types";
  import {
    applyHomography,
    buildVideoClonePath,
    prepareTracePoints,
    samplePixelColor,
    solveHomography,
    trackColorCentroid,
    type Homography,
    type PixelPoint,
    type RgbColor,
    type TraceSample,
    type VideoClonePath,
  } from "../../utils/videoPathCloner";

  export let isOpen = false;
  export let onApply: (result: VideoClonePath) => void = () => {};

  let videoEl: HTMLVideoElement | null = null;
  let canvasEl: HTMLCanvasElement | null = null;
  let videoUrl = "";
  let videoName = "";
  let duration = 0;
  let currentTime = 0;
  let mode: "corners" | "robot" | "manual" = "corners";
  let cornerPixels: PixelPoint[] = [];
  let robotPixel: PixelPoint | null = null;
  let targetColor: RgbColor | null = null;
  let tracedSamples: TraceSample[] = [];
  let preparedPoints: BasePoint[] = [];
  let tracing = false;
  let statusText = "Load footage";
  let progressPercent = 0;

  let frameStepMs = 160;
  let tolerance = 46;
  let searchRadius = 90;
  let minBlobPixels = 18;
  let minPointDistance = 4;
  let simplifyDistance = 2.2;
  let maxPoints = 20;

  const cornerLabels = ["BL", "BR", "TR", "TL"];
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  $: canTrace = Boolean(videoEl && duration > 0 && cornerPixels.length === 4 && targetColor);
  $: canImport = preparedPoints.length >= 2;

  onDestroy(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  });

  $: if (isOpen) {
    window.setTimeout(drawFrame, 0);
  }

  function resetTrace() {
    tracedSamples = [];
    preparedPoints = [];
    progressPercent = 0;
    drawFrame();
  }

  function resetCalibration() {
    cornerPixels = [];
    robotPixel = null;
    targetColor = null;
    resetTrace();
    statusText = "Calibration cleared";
  }

  function getCanvasPoint(event: MouseEvent): PixelPoint | null {
    if (!canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvasEl.width,
      y: ((event.clientY - rect.top) / rect.height) * canvasEl.height,
    };
  }

  function nearestCornerIndex(point: PixelPoint) {
    let bestIdx = 0;
    let bestDistance = Infinity;
    cornerPixels.forEach((corner, idx) => {
      const dist = Math.hypot(corner.x - point.x, corner.y - point.y);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }

  function currentHomography(): Homography | null {
    if (cornerPixels.length !== 4) return null;
    try {
      return solveHomography(cornerPixels);
    } catch (error) {
      statusText = error instanceof Error ? error.message : "Calibration failed";
      return null;
    }
  }

  function handleCanvasClick(event: MouseEvent) {
    const point = getCanvasPoint(event);
    if (!point || !canvasEl) return;

    if (mode === "corners") {
      if (cornerPixels.length < 4) {
        cornerPixels = [...cornerPixels, point];
      } else {
        const idx = nearestCornerIndex(point);
        cornerPixels = cornerPixels.map((corner, cornerIdx) =>
          cornerIdx === idx ? point : corner,
        );
      }
      resetTrace();
      statusText =
        cornerPixels.length < 4
          ? `Corner ${cornerPixels.length + 1} of 4`
          : "Field calibrated";
      drawFrame();
      return;
    }

    if (mode === "robot") {
      const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      targetColor = samplePixelColor(imageData, point);
      robotPixel = point;
      resetTrace();
      statusText = "Robot color picked";
      drawFrame();
      return;
    }

    const h = currentHomography();
    if (!h) return;
    const field = applyHomography(h, point);
    tracedSamples = [
      ...tracedSamples,
      {
        time: currentTime,
        pixel: point,
        field,
      },
    ].sort((a, b) => a.time - b.time);
    preparedPoints = prepareCurrentPoints();
    statusText = `${preparedPoints.length} path points`;
    drawFrame();
  }

  function prepareCurrentPoints() {
    return prepareTracePoints(
      tracedSamples.map((sample) => sample.field),
      {
        minDistance,
        simplification: simplifyDistance,
        maxPoints,
      },
    );
  }

  function drawPoint(
    ctx: CanvasRenderingContext2D,
    point: PixelPoint,
    label: string,
    color: string,
  ) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = "600 13px Poppins, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#111827";
    ctx.fillText(label, point.x, point.y - 18);
    ctx.restore();
  }

  function drawPolyline(
    ctx: CanvasRenderingContext2D,
    points: PixelPoint[],
    color: string,
    width: number,
  ) {
    if (points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.stroke();
    ctx.restore();
  }

  function drawFrame() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const hasVideo = Boolean(videoEl?.videoWidth && videoEl?.videoHeight);
    const width = hasVideo ? videoEl!.videoWidth : 960;
    const height = hasVideo ? videoEl!.videoHeight : 540;

    if (canvasEl.width !== width) canvasEl.width = width;
    if (canvasEl.height !== height) canvasEl.height = height;

    ctx.clearRect(0, 0, width, height);
    if (hasVideo) {
      ctx.drawImage(videoEl!, 0, 0, width, height);
    } else {
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "600 20px Poppins, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Video preview", width / 2, height / 2);
    }

    if (cornerPixels.length > 1) {
      drawPolyline(ctx, [...cornerPixels, cornerPixels[0]], "#22d3ee", 3);
    }

    cornerPixels.forEach((corner, idx) => {
      drawPoint(ctx, corner, cornerLabels[idx] || `${idx + 1}`, "#67e8f9");
    });

    if (tracedSamples.length > 1) {
      drawPolyline(
        ctx,
        tracedSamples.map((sample) => sample.pixel),
        "#facc15",
        4,
      );
    }

    tracedSamples.forEach((sample, idx) => {
      if (idx % Math.ceil(Math.max(1, tracedSamples.length / 18)) === 0) {
        drawPoint(ctx, sample.pixel, "", "#fde047");
      }
    });

    if (robotPixel) {
      drawPoint(ctx, robotPixel, "R", "#fb7185");
    }
  }

  function handleVideoFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file);
    videoName = file.name;
    duration = 0;
    currentTime = 0;
    progressPercent = 0;
    cornerPixels = [];
    robotPixel = null;
    targetColor = null;
    tracedSamples = [];
    preparedPoints = [];
    statusText = "Loading video";

    if (videoEl) {
      videoEl.src = videoUrl;
      videoEl.load();
    }
    input.value = "";
  }

  function handleLoadedMetadata() {
    if (!videoEl) return;
    duration = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    currentTime = 0;
    statusText = "Pick field corners";
    drawFrame();
  }

  function handleSeeked() {
    if (!videoEl) return;
    currentTime = videoEl.currentTime;
    drawFrame();
  }

  function seekTo(time: number): Promise<void> {
    if (!videoEl || !Number.isFinite(duration)) return Promise.resolve();
    const target = clamp(time, 0, duration);

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        videoEl?.removeEventListener("seeked", finish);
        currentTime = videoEl?.currentTime || target;
        drawFrame();
        resolve();
      };

      if (Math.abs((videoEl.currentTime || 0) - target) < 0.003) {
        finish();
        return;
      }

      videoEl.addEventListener("seeked", finish, { once: true });
      window.setTimeout(finish, 650);
      videoEl.currentTime = target;
    });
  }

  async function handleTimeInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    await seekTo(Number(input.value));
  }

  async function traceVideo() {
    if (!videoEl || !canvasEl || !targetColor || tracing) return;
    const h = currentHomography();
    if (!h) return;

    const scratch = document.createElement("canvas");
    scratch.width = videoEl.videoWidth || canvasEl.width;
    scratch.height = videoEl.videoHeight || canvasEl.height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    tracing = true;
    progressPercent = 0;
    statusText = "Tracing";

    const samples: TraceSample[] = [];
    const restoreTime = currentTime;
    let lastPixel = robotPixel;
    const secondsPerFrame = Math.max(0.03, frameStepMs / 1000);
    const frameCount = Math.max(1, Math.ceil(duration / secondsPerFrame));

    try {
      videoEl.pause();
      for (let frame = 0; frame <= frameCount; frame++) {
        const time = Math.min(duration, frame * secondsPerFrame);
        await seekTo(time);

        ctx.drawImage(videoEl, 0, 0, scratch.width, scratch.height);
        const imageData = ctx.getImageData(0, 0, scratch.width, scratch.height);
        let centroid = trackColorCentroid(imageData, targetColor, lastPixel, {
          tolerance,
          minBlobPixels,
          searchRadius,
        });

        if (!centroid && lastPixel) {
          centroid = trackColorCentroid(imageData, targetColor, null, {
            tolerance,
            minBlobPixels,
            searchRadius,
          });
        }

        if (centroid) {
          lastPixel = centroid;
          samples.push({
            time,
            pixel: centroid,
            field: applyHomography(h, centroid),
          });
        }

        if (frame % 4 === 0 || frame === frameCount) {
          progressPercent = Math.round((frame / frameCount) * 100);
          statusText = `Tracing ${progressPercent}%`;
          await tick();
        }
      }

      tracedSamples = samples;
      preparedPoints = prepareCurrentPoints();
      statusText = `${preparedPoints.length} path points`;
      await seekTo(restoreTime);
      drawFrame();
    } catch (error) {
      statusText = error instanceof Error ? error.message : "Trace failed";
    } finally {
      tracing = false;
    }
  }

  function importClone() {
    try {
      const result = buildVideoClonePath(preparedPoints, "#38bdf8", "Video Clone");
      onApply(result);
      isOpen = false;
    } catch (error) {
      statusText = error instanceof Error ? error.message : "Import failed";
    }
  }
</script>

{#if isOpen}
  <div
    class="bg-black bg-opacity-40 flex flex-col justify-center items-center absolute top-0 left-0 w-full h-full z-[1006]"
    role="dialog"
    aria-modal="true"
    aria-label="Clone auto from video"
  >
    <div
      class="flex flex-col bg-white dark:bg-neutral-900 rounded-lg w-[min(96vw,1180px)] max-h-[92vh] shadow-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"
    >
      <div class="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-700">
        <div class="flex flex-col">
          <p class="font-semibold text-neutral-800 dark:text-neutral-100">Clone Auto</p>
          <p class="text-xs text-neutral-500 dark:text-neutral-400">
            {videoName || statusText}
          </p>
        </div>
        <button
          on:click={() => (isOpen = false)}
          aria-label="Close video clone dialog"
          class="p-1 rounded"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="2"
            stroke="currentColor"
            class="size-6"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_21rem] gap-0 overflow-auto">
        <div class="p-4 bg-neutral-100 dark:bg-neutral-950">
          <div class="relative w-full rounded-md overflow-hidden border border-neutral-200 dark:border-neutral-700 bg-neutral-950">
            <canvas
              bind:this={canvasEl}
              on:click={handleCanvasClick}
              class="block w-full max-h-[68vh] object-contain cursor-crosshair"
            />
            <video
              bind:this={videoEl}
              src={videoUrl}
              muted
              playsinline
              class="hidden"
              on:loadedmetadata={handleLoadedMetadata}
              on:loadeddata={drawFrame}
              on:seeked={handleSeeked}
            />
            {#if tracing}
              <div class="absolute left-4 right-4 bottom-4 h-2 rounded-full bg-black/40 overflow-hidden">
                <div class="h-full bg-cyan-400" style="width: {progressPercent}%" />
              </div>
            {/if}
          </div>
        </div>

        <div class="p-4 flex flex-col gap-4 border-l border-neutral-200 dark:border-neutral-700 overflow-y-auto">
          <label
            class="flex items-center justify-center gap-2 rounded-md border border-dashed border-neutral-300 dark:border-neutral-600 px-3 py-3 text-sm font-semibold text-neutral-700 dark:text-neutral-200 cursor-pointer"
          >
            <input
              type="file"
              accept="video/*"
              class="hidden"
              on:change={handleVideoFile}
            />
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="2"
              stroke="currentColor"
              class="size-5"
            >
              <path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9A2.25 2.25 0 0 0 13.5 5.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
            Video File
          </label>

          <div class="grid grid-cols-3 gap-2">
            <button
              on:click={() => (mode = "corners")}
              class:bg-cyan-500={mode === "corners"}
              class:text-white={mode === "corners"}
              class="px-2 py-2 rounded-md text-xs font-semibold border border-neutral-300 dark:border-neutral-700"
            >
              Corners
            </button>
            <button
              on:click={() => (mode = "robot")}
              class:bg-rose-500={mode === "robot"}
              class:text-white={mode === "robot"}
              class="px-2 py-2 rounded-md text-xs font-semibold border border-neutral-300 dark:border-neutral-700"
            >
              Robot
            </button>
            <button
              on:click={() => (mode = "manual")}
              class:bg-amber-400={mode === "manual"}
              class:text-neutral-950={mode === "manual"}
              class="px-2 py-2 rounded-md text-xs font-semibold border border-neutral-300 dark:border-neutral-700"
            >
              Manual
            </button>
          </div>

          <div class="rounded-md border border-neutral-200 dark:border-neutral-700 p-3 flex flex-col gap-3">
            <div class="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
              <span>{cornerPixels.length}/4 corners</span>
              <span>{targetColor ? "color picked" : "no color"}</span>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <span class="text-neutral-500 dark:text-neutral-400">Order</span>
              {#each cornerLabels as label, idx}
                <span
                  class="px-2 py-1 rounded border text-[11px]"
                  class:bg-cyan-100={idx < cornerPixels.length}
                  class:text-cyan-800={idx < cornerPixels.length}
                  class:border-cyan-300={idx < cornerPixels.length}
                >
                  {label}
                </span>
              {/each}
            </div>
            {#if targetColor}
              <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span
                  class="size-5 rounded border border-neutral-300"
                  style="background-color: rgb({targetColor.r}, {targetColor.g}, {targetColor.b})"
                />
                <span>rgb({targetColor.r}, {targetColor.g}, {targetColor.b})</span>
              </div>
            {/if}
          </div>

          <div class="flex flex-col gap-3 rounded-md border border-neutral-200 dark:border-neutral-700 p-3">
            <label class="text-xs font-semibold text-neutral-600 dark:text-neutral-300" for="video-time">
              Time
            </label>
            <input
              id="video-time"
              type="range"
              min="0"
              max={duration || 0}
              step="0.03"
              value={currentTime}
              on:input={handleTimeInput}
              class="slider w-full"
              disabled={!duration || tracing}
            />
            <div class="text-xs text-neutral-500 dark:text-neutral-400">
              {currentTime.toFixed(2)}s / {(duration || 0).toFixed(2)}s
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              Step ms
              <input
                type="number"
                min="40"
                max="1000"
                bind:value={frameStepMs}
                class="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-sm"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              Tolerance
              <input
                type="number"
                min="5"
                max="180"
                bind:value={tolerance}
                class="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-sm"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              Search px
              <input
                type="number"
                min="0"
                max="400"
                bind:value={searchRadius}
                class="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-sm"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              Blob px
              <input
                type="number"
                min="1"
                max="500"
                bind:value={minBlobPixels}
                class="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-sm"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              Min inches
              <input
                type="number"
                min="0"
                max="24"
                step="0.5"
                bind:value={minPointDistance}
                on:change={() => (preparedPoints = prepareCurrentPoints())}
                class="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-sm"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              Max pts
              <input
                type="number"
                min="2"
                max="80"
                bind:value={maxPoints}
                on:change={() => (preparedPoints = prepareCurrentPoints())}
                class="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-sm"
              />
            </label>
          </div>

          <div class="flex flex-col gap-2">
            <button
              on:click={traceVideo}
              disabled={!canTrace || tracing}
              class="w-full px-3 py-2 rounded-md bg-cyan-500 text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {tracing ? "Tracing" : "Trace Auto"}
            </button>
            <button
              on:click={importClone}
              disabled={!canImport}
              class="w-full px-3 py-2 rounded-md bg-emerald-500 text-white font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Import {preparedPoints.length} Points
            </button>
            <div class="grid grid-cols-2 gap-2">
              <button
                on:click={resetTrace}
                class="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-700 text-sm"
              >
                Clear Trace
              </button>
              <button
                on:click={resetCalibration}
                class="px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-700 text-sm"
              >
                Reset
              </button>
            </div>
          </div>

          <p class="text-xs text-neutral-500 dark:text-neutral-400 min-h-4">
            {statusText}
          </p>
        </div>
      </div>
    </div>
  </div>
{/if}
