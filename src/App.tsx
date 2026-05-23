import { Camera, Check, ExternalLink, ImageUp, Minus, Plus, RefreshCcw, ScanLine } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analyzeRuneTab, type RuneRead } from "./lib/vision";
import {
  RUNE_NAMES,
  emptyRuneCounts,
  findCraftableRunewords,
  formatRecipe,
  type RuneCounts,
  type RuneName,
} from "./lib/runewords";

type View = "capture" | "processing" | "results";

const secureCameraAvailable = () =>
  Boolean(navigator.mediaDevices?.getUserMedia) && (window.isSecureContext || location.hostname === "localhost");

function readsToCounts(reads: RuneRead[]): RuneCounts {
  const counts = emptyRuneCounts();
  reads.forEach((read) => {
    counts[read.rune] = read.count;
  });
  return counts;
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [view, setView] = useState<View>("capture");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraIssue, setCameraIssue] = useState("");
  const [captureSrc, setCaptureSrc] = useState("");
  const [progress, setProgress] = useState({ label: "", value: 0 });
  const [reads, setReads] = useState<RuneRead[]>([]);
  const [counts, setCounts] = useState<RuneCounts>(() => emptyRuneCounts());

  const craftable = useMemo(() => findCraftableRunewords(counts), [counts]);
  const detectedRunes = useMemo(() => RUNE_NAMES.filter((rune) => counts[rune] > 0).length, [counts]);
  const uncertainCount = useMemo(() => reads.filter((read) => read.count > 0 && read.confidence < 0.76).length, [reads]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraReady(false);
  }, []);

  const startCamera = useCallback(async () => {
    if (!secureCameraAvailable()) {
      setCameraIssue("Camera preview needs HTTPS. Photo upload still works on mobile.");
      return;
    }

    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
      setCameraIssue("");
    } catch (error) {
      setCameraIssue(error instanceof Error ? error.message : "Camera unavailable.");
    }
  }, [stopCamera]);

  useEffect(() => {
    startCamera();
    return stopCamera;
  }, [startCamera, stopCamera]);

  const processImage = useCallback(async (src: string) => {
    setCaptureSrc(src);
    setView("processing");
    setProgress({ label: "Starting", value: 0 });

    try {
      const result = await analyzeRuneTab(src, (label, value) => setProgress({ label, value }));
      const nextCounts = readsToCounts(result.reads);
      setReads(result.reads);
      setCounts(nextCounts);
      setView("results");
    } catch (error) {
      setCameraIssue(error instanceof Error ? error.message : "Could not process this image.");
      setView("capture");
    }
  }, []);

  const peepFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      fileRef.current?.click();
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    await processImage(canvas.toDataURL("image/jpeg", 0.92));
  }, [processImage]);

  const onFileSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          processImage(reader.result);
        }
      };
      reader.readAsDataURL(file);
      event.target.value = "";
    },
    [processImage],
  );

  const adjustRune = (rune: RuneName, delta: number) => {
    setCounts((current) => ({
      ...current,
      [rune]: Math.max(0, Math.min(999, current[rune] + delta)),
    }));
  };

  const resetScan = () => {
    setReads([]);
    setCounts(emptyRuneCounts());
    setCaptureSrc("");
    setView("capture");
    startCamera();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Diablo II: Resurrected</p>
          <h1>Rune Peep</h1>
        </div>
        <button className="icon-button" type="button" onClick={resetScan} aria-label="New scan">
          <RefreshCcw size={20} />
        </button>
      </header>

      {view === "capture" && (
        <section className="capture-panel" aria-label="Rune scanner">
          <div className="camera-frame">
            <video ref={videoRef} className="camera-video" playsInline muted />
            {!cameraReady && <div className="camera-placeholder">{cameraIssue || "Camera"}</div>}
            <div className="stash-grid" aria-hidden="true">
              {Array.from({ length: 36 }).map((_, index) => (
                <span key={index} className={index > 32 ? "inactive" : ""} />
              ))}
            </div>
            <div className="corner top-left" />
            <div className="corner top-right" />
            <div className="corner bottom-left" />
            <div className="corner bottom-right" />
          </div>

          <div className="capture-actions">
            <button className="primary-action" type="button" onClick={peepFrame}>
              <ScanLine size={22} />
              Peep
            </button>
            <button className="secondary-action" type="button" onClick={() => fileRef.current?.click()}>
              <ImageUp size={20} />
              Photo
            </button>
          </div>
          <input ref={fileRef} className="file-input" type="file" accept="image/*" capture="environment" onChange={onFileSelected} />
        </section>
      )}

      {view === "processing" && (
        <section className="processing-panel" aria-live="polite">
          {captureSrc && <img className="scan-preview" src={captureSrc} alt="" />}
          <div className="progress-block">
            <Camera size={24} />
            <p>{progress.label}</p>
            <div className="progress-track">
              <span style={{ width: `${Math.round(progress.value * 100)}%` }} />
            </div>
          </div>
        </section>
      )}

      {view === "results" && (
        <section className="results-view">
          <div className="summary-strip">
            <div>
              <span>{craftable.length}</span>
              <p>Runewords</p>
            </div>
            <div>
              <span>{detectedRunes}</span>
              <p>Runes</p>
            </div>
            <div>
              <span>{uncertainCount}</span>
              <p>Check</p>
            </div>
          </div>

          <section className="rune-editor" aria-label="Rune counts">
            {RUNE_NAMES.map((rune) => (
              <div className="rune-stepper" key={rune}>
                <strong>{rune}</strong>
                <div>
                  <button type="button" onClick={() => adjustRune(rune, -1)} aria-label={`Decrease ${rune}`}>
                    <Minus size={14} />
                  </button>
                  <span>{counts[rune]}</span>
                  <button type="button" onClick={() => adjustRune(rune, 1)} aria-label={`Increase ${rune}`}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            ))}
          </section>

          <section className="runeword-list" aria-label="Available runewords">
            {craftable.length === 0 ? (
              <div className="empty-state">
                <Check size={24} />
                <p>No complete recipes found from this scan.</p>
              </div>
            ) : (
              craftable.map((word) => (
                <article className="runeword-card" key={`${word.name}-${word.recipe.join("")}`}>
                  <div>
                    <h2>
                      {word.name}
                      {word.maxCrafts > 1 && <em>x{word.maxCrafts}</em>}
                    </h2>
                    <p>{formatRecipe(word.recipe)}</p>
                    <span>{word.itemTypes.join(", ")}</span>
                  </div>
                  <a href={word.detailsUrl} target="_blank" rel="noreferrer" aria-label={`${word.name} details`}>
                    <ExternalLink size={18} />
                  </a>
                </article>
              ))
            )}
          </section>
        </section>
      )}
    </main>
  );
}

export default App;
