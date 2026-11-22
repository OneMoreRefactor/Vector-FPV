import React, { useState } from 'react';
import { Download, Share, Smartphone, WifiOff, CheckCircle2, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

interface PWAInstallButtonProps {
  variant?: 'dock' | 'card';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'dock' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (variant === 'card') {
    if (isInstalled) {
      return (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-cyan-500/30 bg-zinc-900/60 p-4">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-cyan-400" />
            <div>
              <div className="text-xs font-semibold text-zinc-100">Als App installiert (PWA)</div>
              <div className="text-[11px] text-zinc-400">
                Vollbild-Modus & Offline-Cache sind aktiv
              </div>
            </div>
          </div>
          <span className="font-mono-tech text-[10px] font-semibold text-cyan-300">BEREIT</span>
        </div>
      );
    }

    return (
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-zinc-100">
              Als App installieren (PWA · Offline)
            </div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
              {isInstallable
                ? 'Direkt auf dem Startbildschirm installieren für Vollbild ohne Browserleiste und Offline-Flug.'
                : isIOS
                ? 'In iPadOS/iOS Safari über „Teilen → Zum Home-Bildschirm“ für echtes Vollbild & Offline-Start hinzufügen.'
                : 'Über das Browser-Menü „App installieren“ bzw. in Safari „Zum Home-Bildschirm“ ablegen.'}
            </div>
          </div>
          {isInstallable ? (
            <button
              type="button"
              onClick={() => void install()}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-amber-500 px-3 text-xs font-semibold text-zinc-950 transition-colors hover:bg-amber-400"
            >
              <Download className="h-3.5 w-3.5" />
              Installieren
            </button>
          ) : isIOS ? (
            <button
              type="button"
              onClick={() => setShowIOSGuide(true)}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-amber-500/60 bg-amber-500/15 px-3 text-xs font-semibold text-amber-300 transition-colors hover:bg-amber-500/25"
            >
              <Smartphone className="h-3.5 w-3.5" />
              iPad-Anleitung
            </button>
          ) : null}
        </div>
        {showIOSGuide && <IOSInstallModal onClose={() => setShowIOSGuide(false)} />}
      </div>
    );
  }

  // Dock variant: automatically hidden if already running as installed standalone PWA
  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="flex min-h-[42px] items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-zinc-900 px-3 py-2 text-xs font-semibold text-cyan-300 whitespace-nowrap transition-colors hover:border-cyan-400 hover:bg-zinc-800"
        title="Als Offline-App (PWA) installieren"
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden md:inline">Installieren</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="flex min-h-[42px] items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-zinc-900 px-3 py-2 text-xs font-semibold text-cyan-300 whitespace-nowrap transition-colors hover:border-cyan-400 hover:bg-zinc-800"
          title="Auf iPad Home-Bildschirm installieren"
        >
          <Download className="h-3.5 w-3.5 shrink-0" />
          <span className="hidden md:inline">App</span>
        </button>

        {showIOSGuide && <IOSInstallModal onClose={() => setShowIOSGuide(false)} />}
      </>
    );
  }

  return null;
};

const IOSInstallModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
    <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-950 p-5 text-zinc-100 shadow-2xl">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-sm font-bold tracking-wide text-amber-400">
          Auf iPad / iPhone installieren
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"
          aria-label="Schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ol className="mt-3 space-y-2.5 text-xs leading-relaxed text-zinc-300">
        <li className="flex items-start gap-2">
          <span className="font-mono-tech mt-0.5 font-bold text-amber-400">1.</span>
          <span>
            Tippe in der Safari-Symbolleiste auf das{' '}
            <strong className="inline-flex items-center gap-1 text-white">
              Teilen-Symbol <Share className="inline h-3.5 w-3.5 text-cyan-300" />
            </strong>
            .
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="font-mono-tech mt-0.5 font-bold text-amber-400">2.</span>
          <span>
            Scrolle nach unten und tippe auf <strong className="text-white">Zum Home-Bildschirm</strong>.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <span className="font-mono-tech mt-0.5 font-bold text-amber-400">3.</span>
          <span>
            Bestätige mit <strong className="text-white">Hinzufügen</strong> und starte Vektor FPV danach über das neue App-Icon im Vollbild- & Offline-Modus.
          </span>
        </li>
      </ol>
      <button
        type="button"
        onClick={onClose}
        className="mt-5 min-h-[40px] w-full rounded-lg bg-amber-500 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-amber-400"
      >
        Verstanden
      </button>
    </div>
  </div>
);

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="pointer-events-none fixed top-11 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-amber-500/60 bg-zinc-950/90 px-2.5 py-1 text-[11px] font-medium text-amber-300 shadow-lg">
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>Offline-Modus · Lokal zwischengespeichert</span>
    </div>
  );
};
