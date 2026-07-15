import type { EnterpriseCurrentAccess } from '@shared/enterprise/constants';
import React, { useEffect, useState } from 'react';

interface WelcomeDialogProps {
  onEnterpriseActivate: (input: { serverUrl: string; activationCode: string }) => Promise<{
    success: boolean;
    access?: EnterpriseCurrentAccess;
    error?: string;
  }>;
}

const DEFAULT_ENTERPRISE_URL = 'http://127.0.0.1:8787';

const WelcomeDialog: React.FC<WelcomeDialogProps> = ({ onEnterpriseActivate }) => {
  const [serverUrl, setServerUrl] = useState(DEFAULT_ENTERPRISE_URL);
  const [activationCode, setActivationCode] = useState('');
  const [isActivating, setIsActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron.enterprise.getStatus()
      .then(result => {
        if (cancelled || !result.success) return;
        const savedUrl = result.status?.serverUrl?.trim();
        if (savedUrl) {
          setServerUrl(savedUrl);
        }
        const savedCode = result.status?.lastActivationCode?.trim();
        if (savedCode) {
          setActivationCode(savedCode);
        }
      })
      .catch(() => {
        // Keep the bundled default when enterprise status is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleActivate = async () => {
    const trimmedCode = activationCode.trim();
    if (!trimmedCode) {
      setError('请输入员工激活码');
      return;
    }

    setIsActivating(true);
    setError(null);
    const result = await onEnterpriseActivate({
      serverUrl,
      activationCode: trimmedCode,
    });
    if (!result.success) {
      setError(result.error || '激活失败，请检查激活码是否正确');
      setIsActivating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-surface">
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(251, 190, 0, 0.12) 0%, rgba(255,255,255,0) 52%)' }}
      />

      <div className="relative z-10 flex w-[420px] flex-col items-center px-8 py-12">
        <img
          src="logo.png"
          alt="LfClaw"
          width={72}
          height={72}
          className="mb-5 select-none rounded-2xl"
          draggable={false}
        />

        <h1 className="mb-2 text-center text-2xl font-bold text-foreground">
          欢迎使用 LfClaw
        </h1>

        <p className="mb-7 text-center text-sm text-secondary">
          请输入员工激活码，激活后会自动同步模型、MCP 和技能权限。
        </p>

        <div className="flex w-full flex-col gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-secondary">员工激活码</label>
            <input
              value={activationCode}
              onChange={event => setActivationCode(event.target.value.toUpperCase())}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  void handleActivate();
                }
              }}
              className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm font-medium tracking-wide text-foreground outline-none transition-colors focus:border-primary"
              placeholder="LFCLAW-ZHANGSAN-8F2A"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            onClick={() => void handleActivate()}
            disabled={isActivating}
            className="mt-1 h-11 w-full rounded-lg bg-slate-950 text-sm font-medium text-white shadow-[0_8px_18px_rgba(15,23,42,0.18)] transition-opacity hover:opacity-90 active:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isActivating ? '正在激活...' : '激活并进入'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeDialog;
