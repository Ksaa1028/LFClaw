import { CheckCircleIcon } from '@heroicons/react/24/outline';
import type { EnterpriseStatus } from '@shared/enterprise/constants';
import React, { useCallback, useEffect, useState } from 'react';

import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';

interface EnterpriseActivationViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const joinList = (items: string[]): string => (items.length > 0 ? items.join(', ') : '未授权');

const formatDate = (value: string | null | undefined): string => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const EnterpriseActivationView: React.FC<EnterpriseActivationViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const [status, setStatus] = useState<EnterpriseStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const showMessage = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2400);
  }, []);

  const refresh = useCallback(async () => {
    const result = await window.electron.enterprise.getStatus();
    if (result.success && result.status) {
      setStatus(result.status);
    } else if (result.error) {
      showMessage(result.error);
    }
  }, [showMessage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const access = status?.access ?? null;
  const quota = access?.quota;
  const policy = access?.policy;
  const activationCodeDisplay = access?.activationCode || status?.lastActivationCode || '-';

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      <div className="draggable flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex h-8 items-center space-x-3">
          {isSidebarCollapsed && !isWindows && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold text-foreground">LfClaw 企业激活</h1>
        </div>
        {message && (
          <div className="non-draggable rounded-md bg-primary/10 px-3 py-1 text-sm text-primary">
            {message}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[960px] px-6 py-6">
          <section className="rounded-lg border border-border bg-surface p-5">
            <h2 className="text-xl font-semibold text-foreground">企业激活码</h2>

            <div className="mt-5 max-w-md rounded-md border border-border bg-background px-3 py-2">
              <div className="text-xs text-secondary">激活码</div>
              <div className="mt-1 break-all font-mono text-sm font-semibold text-foreground">
                {activationCodeDisplay}
              </div>
            </div>
          </section>

          <section className="mt-5 rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center gap-2">
              <CheckCircleIcon className={`h-5 w-5 ${access ? 'text-green-500' : 'text-secondary'}`} />
              <h2 className="text-lg font-semibold text-foreground">
                {access ? policy?.enterpriseName || '已连接企业' : '未激活企业账号'}
              </h2>
            </div>
            {access ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Info label="员工" value={`${access.user.nickname} / ${access.user.userId}`} />
                <Info label="最近更新" value={formatDate(access.syncedAt)} />
                <Info label="积分" value={quota ? `${quota.creditsRemaining}/${quota.creditsLimit}` : '-'} />
                <Info label="模型" value={joinList(policy?.allowedModelIds ?? [])} />
                <Info label="MCP" value={joinList(policy?.allowedMcpServerIds ?? [])} />
                <Info label="技能" value={joinList(policy?.allowedSkillIds ?? [])} />
              </div>
            ) : (
              <p className="mt-3 text-sm text-secondary">
                请通过首次登录激活页输入企业激活码。
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-md border border-border bg-background p-3">
    <div className="text-xs text-secondary">{label}</div>
    <div className="mt-1 break-words text-sm font-medium text-foreground">{value}</div>
  </div>
);

export default EnterpriseActivationView;
