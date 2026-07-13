import type { ShellOpenFailureReason as ShellOpenFailureReasonType } from '../../shared/shell/constants';
import { ShellOpenFailureReason } from '../../shared/shell/constants';
import { i18nService } from '../services/i18n';

export interface ShellActionResult {
  success: boolean;
  error?: string;
  reason?: ShellOpenFailureReasonType;
}

export const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

export const getShellFailureMessage = (
  result: ShellActionResult | undefined | null,
  fallbackKey: string,
): string => {
  switch (result?.reason) {
    case ShellOpenFailureReason.NotFound:
      return i18nService.t('localFileNotFound');
    case ShellOpenFailureReason.PermissionDenied:
      return i18nService.t('localFilePermissionDenied');
    case ShellOpenFailureReason.OpenFailed:
    case ShellOpenFailureReason.Unknown:
    default:
      return result?.error || i18nService.t(fallbackKey);
  }
};

export const showShellFailureToast = (
  result: ShellActionResult | undefined | null,
  fallbackKey = 'openFileFailed',
): void => {
  showToast(getShellFailureMessage(result, fallbackKey));
};

const logLocalFileActionFailure = (
  operation: string,
  filePath: string,
  result: ShellActionResult | undefined | null,
): void => {
  console.warn(
    `[LocalFileActions] failed to ${operation} local path because ${result?.reason || 'the shell request failed'}:`,
    filePath,
    result?.error,
  );
};

export const isRemoteOpenClawFilePath = (filePath: string): boolean => {
  const normalized = String(filePath || '').trim().replace(/^file:\/\//i, '');
  return /^\/root\/\.openclaw\/workspace\//i.test(normalized)
    || /^\\root\\\.openclaw\\workspace\\/i.test(normalized)
    || /^\/opt\/lobsterai-gateway-manager\/users\/[^/]+\/(?:workspace|state|home)\//i.test(normalized)
    || /^\\opt\\lobsterai-gateway-manager\\users\\[^\\]+\\(?:workspace|state|home)\\/i.test(normalized);
};

export const downloadRemoteOpenClawFile = async (filePath: string): Promise<string | null> => {
  const result = await window.electron?.enterprise?.downloadRemoteFile?.(filePath);
  if (result?.success && result.filePath) {
    showToast(`已下载到本地：${result.filePath}`);
    return result.filePath;
  }
  showToast(result?.error || '远程文件下载失败');
  return null;
};

export const openLocalPathWithToast = async (
  filePath: string,
  fallbackKey = 'openFileFailed',
): Promise<boolean> => {
  try {
    const targetPath = isRemoteOpenClawFilePath(filePath)
      ? await downloadRemoteOpenClawFile(filePath)
      : filePath;
    if (!targetPath) return false;
    const result = await window.electron?.shell?.openPath(targetPath);
    if (result?.success) return true;
    logLocalFileActionFailure('open', targetPath, result);
    showShellFailureToast(result, fallbackKey);
    return false;
  } catch (error) {
    console.warn('[LocalFileActions] failed to open local path because the shell call threw:', filePath, error);
    showToast(i18nService.t(fallbackKey));
    return false;
  }
};

export const revealLocalPathWithToast = async (
  filePath: string,
  fallbackKey = 'showInFolderFailed',
): Promise<boolean> => {
  try {
    const targetPath = isRemoteOpenClawFilePath(filePath)
      ? await downloadRemoteOpenClawFile(filePath)
      : filePath;
    if (!targetPath) return false;
    const result = await window.electron?.shell?.showItemInFolder(targetPath);
    if (result?.success) return true;
    logLocalFileActionFailure('reveal', targetPath, result);
    showShellFailureToast(result, fallbackKey);
    return false;
  } catch (error) {
    console.warn('[LocalFileActions] failed to reveal local path because the shell call threw:', filePath, error);
    showToast(i18nService.t(fallbackKey));
    return false;
  }
};
