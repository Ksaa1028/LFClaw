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

const normalizeItems = (items: string[] | undefined): string[] => (
  Array.from(new Set((items ?? []).map(item => item.trim()).filter(Boolean)))
);

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
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-background">
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
          <h1 className="text-lg font-semibold text-foreground">LFClaw 企业激活</h1>
        </div>
        {message && (
          <div className="non-draggable rounded-md bg-primary/10 px-3 py-1 text-sm text-primary">
            {message}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex h-full w-full max-w-[960px] min-h-0 flex-col gap-5 px-6 py-6">
          <section className="shrink-0 rounded-lg border border-border bg-surface p-5 shadow-sm">
            <h2 className="text-xl font-semibold text-foreground">企业激活码</h2>

            <div className="mt-5 max-w-md rounded-md border border-border bg-background px-3 py-2">
              <div className="text-xs text-secondary">激活码</div>
              <div className="mt-1 break-all font-mono text-sm font-semibold text-foreground">
                {activationCodeDisplay}
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-surface p-5 shadow-sm">
            <div className="flex shrink-0 items-center gap-2">
              <CheckCircleIcon className={`h-5 w-5 ${access ? 'text-green-500' : 'text-secondary'}`} />
              <h2 className="text-lg font-semibold text-foreground">
                {access ? policy?.enterpriseName || '已连接企业' : '未激活企业账号'}
              </h2>
            </div>
            {access ? (
              <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                <div className="grid gap-3 pb-1 md:grid-cols-2">
                <Info label="员工" value={`${access.user.nickname} / ${access.user.userId}`} />
                <Info label="最近更新" value={formatDate(access.syncedAt)} />
                <Info label="积分" value={quota ? `${quota.creditsRemaining}/${quota.creditsLimit}` : '-'} />
                <Info label="模型" value={<ChipList items={normalizeItems(policy?.allowedModelIds)} />} />
                <Info label="MCP" value={<ChipList items={normalizeItems(policy?.allowedMcpServerIds)} />} />
                <Info label="技能" value={<ChipList items={normalizeItems(policy?.allowedSkillIds)} />} />
                </div>
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

const Info: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="rounded-lg border border-border bg-background/70 p-3 shadow-sm">
    <div className="text-xs text-secondary">{label}</div>
    <div className="mt-1 break-words text-sm font-medium text-foreground">{value}</div>
  </div>
);

const ChipList: React.FC<{ items: string[] }> = ({ items }) => {
  if (items.length === 0) {
    return <span className="text-secondary">未授权</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => (
        <span
          key={item}
          className="inline-flex max-w-full items-center rounded-md border border-primary/15 bg-primary/5 px-2 py-1 text-xs font-medium text-primary"
          title={item}
        >
          <span className="truncate">{item}</span>
        </span>
      ))}
    </div>
  );
};

export default EnterpriseActivationView;
