import { LightBulbIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState } from 'react';

import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { OpenClawEngineStatus } from '../../types/cowork';

const TIP_KEYS = [
  'engineStartingTip1',
  'engineStartingTip2',
  'engineStartingTip3',
  'engineStartingTip4',
  'engineStartingTip5',
  'engineStartingTip6',
] as const;

const TIP_ROTATE_MS = 5000;
const SLOW_HINT_AFTER_MS = 15000;

const resolveEngineStatusText = (status: OpenClawEngineStatus): string => {
  switch (status.phase) {
    case 'not_installed':
      return i18nService.t('coworkOpenClawNotInstalledNotice');
    case 'installing':
      return i18nService.t('coworkOpenClawInstalling');
    case 'ready':
      return i18nService.t('coworkOpenClawReadyNotice');
    case 'starting':
      return i18nService.t('coworkOpenClawStarting');
    case 'error':
      return i18nService.t('coworkOpenClawError');
    case 'running':
    default:
      return i18nService.t('coworkOpenClawRunning');
  }
};

/**
 * Global overlay shown when the OpenClaw gateway is starting up.
 * Renders on top of all views (cowork, skills, scheduled tasks, mcp).
 * Styled after WelcomeDialog so first-run flows feel continuous, with
 * rotating feature tips to keep the (10s-2min) wait from feeling idle.
 */
const EngineStartupOverlay: React.FC = () => {
  const [status, setStatus] = useState<OpenClawEngineStatus | null>(null);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * TIP_KEYS.length));
  const [showSlowHint, setShowSlowHint] = useState(false);

  useEffect(() => {
    coworkService.getOpenClawEngineStatus().then((s) => {
      if (s) setStatus(s);
    });

    const unsubscribe = coworkService.onOpenClawEngineStatus((s) => {
      setStatus(s);
    });

    return unsubscribe;
  }, []);

  const isStarting = status?.phase === 'starting';

  useEffect(() => {
    if (!isStarting) {
      setShowSlowHint(false);
      return;
    }

    const tipTimer = setInterval(() => {
      setTipIndex((prev) => (prev + 1) % TIP_KEYS.length);
    }, TIP_ROTATE_MS);
    const slowHintTimer = setTimeout(() => {
      setShowSlowHint(true);
    }, SLOW_HINT_AFTER_MS);

    return () => {
      clearInterval(tipTimer);
      clearTimeout(slowHintTimer);
    };
  }, [isStarting]);

  if (!status || !isStarting) {
    return null;
  }

  const progressPercent = typeof status.progressPercent === 'number'
    ? Math.max(0, Math.min(100, Math.round(status.progressPercent)))
    : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface animate-fade-in">
      {/* brand gradient, same as WelcomeDialog */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(360deg, rgba(255, 0, 77, 0) 5.5%, rgba(255, 0, 77, 0.05) 100%)' }}
        aria-hidden="true"
      />

      <div className="relative z-10 flex w-[420px] flex-col items-center px-6" role="status">
        {/* logo with breathing glow */}
        <div className="relative mb-5">
          <div className="absolute -inset-2 rounded-3xl bg-primary/20 blur-xl animate-pulse" aria-hidden="true" />
          <img
            src="logo.png"
            alt="LfClaw"
            width={72}
            height={72}
            className="relative rounded-2xl select-none"
            draggable={false}
          />
        </div>

        <h1 className="text-2xl font-bold text-foreground mb-2 text-center">
          {i18nService.t('engineStartingTitle')}
        </h1>
        <p className="text-sm text-secondary mb-8 text-center">
          {resolveEngineStatusText(status)}
        </p>

        {/* progress bar with shimmer */}
        <div className="w-full h-1.5 rounded-full bg-primary/15 overflow-hidden">
          {progressPercent !== null ? (
            <div
              className="relative h-full rounded-full bg-primary overflow-hidden transition-all duration-500 ease-smooth"
              style={{ width: `${Math.max(progressPercent, 4)}%` }}
            >
              <div
                className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/40 to-transparent"
                aria-hidden="true"
              />
            </div>
          ) : (
            <div className="relative h-full overflow-hidden">
              <div
                className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-primary to-transparent"
                aria-hidden="true"
              />
            </div>
          )}
        </div>
        <div className="mt-1.5 flex w-full items-center justify-between gap-3 min-h-[1rem]">
          <span className={`text-xs text-muted transition-opacity duration-500 ${showSlowHint ? 'opacity-100' : 'opacity-0'}`}>
            {i18nService.t('engineStartingSlowHint')}
          </span>
          {progressPercent !== null && (
            <span className="text-xs tabular-nums text-secondary shrink-0">{progressPercent}%</span>
          )}
        </div>

        {/* rotating feature tips */}
        <div className="mt-10 w-full rounded-xl border border-border-subtle bg-surface-raised/60 px-4 py-3">
          <div key={tipIndex} className="animate-fade-in-up">
            <div className="flex items-center gap-1.5 text-xs font-medium text-primary mb-1">
              <LightBulbIcon className="h-3.5 w-3.5" />
              {i18nService.t('engineStartingTipLabel')}
            </div>
            <p className="text-sm text-secondary leading-relaxed min-h-[2.5rem]">
              {i18nService.t(TIP_KEYS[tipIndex])}
            </p>
          </div>
          <div className="mt-2 flex justify-center gap-1.5" aria-hidden="true">
            {TIP_KEYS.map((key, idx) => (
              <span
                key={key}
                className={`h-1 rounded-full transition-all duration-300 ${
                  idx === tipIndex ? 'w-3 bg-primary' : 'w-1 bg-primary/25'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EngineStartupOverlay;
