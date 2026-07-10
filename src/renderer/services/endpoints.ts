/**
 * 集中管理所有业务 API 端点。
 * 后续新增的业务接口也应在此文件中配置。
 */

import { configService } from './config';

const ENTERPRISE_DOCS_URL = 'https://bxz6lqekwy.feishu.cn/wiki/DHIgws6jkiizt1kOWsOcdr1jnSg';

export const isTestModeEnabled = () => {
  return configService.getConfig().app?.testMode === true;
};

// 自动更新
export const getUpdateCheckUrl = () => ENTERPRISE_DOCS_URL;

// 手动检查更新
export const getManualUpdateCheckUrl = () => ENTERPRISE_DOCS_URL;

export const getFallbackDownloadUrl = () => ENTERPRISE_DOCS_URL;

// Skill 商店
export const getSkillStoreUrl = () => ENTERPRISE_DOCS_URL;

// Kit 商店
export const getKitStoreUrl = () => ENTERPRISE_DOCS_URL;

// 登录地址
export const getLoginOvermindUrl = () => ENTERPRISE_DOCS_URL;

// Portal 页面
const PORTAL_BASE_TEST = ENTERPRISE_DOCS_URL;
const PORTAL_BASE_PROD = ENTERPRISE_DOCS_URL;

const getPortalBase = () => isTestModeEnabled() ? PORTAL_BASE_TEST : PORTAL_BASE_PROD;

export const PortalPricingKeyfrom = {
  HtmlShare: 'html_share',
} as const;

export type PortalPricingKeyfrom =
  (typeof PortalPricingKeyfrom)[keyof typeof PortalPricingKeyfrom];

export const getPortalLoginUrl = () => `${getPortalBase()}/login`;
export const getPortalPricingUrl = (keyfrom?: PortalPricingKeyfrom) => (
  `${getPortalBase()}/pricing${keyfrom ? `?keyfrom=${encodeURIComponent(keyfrom)}` : ''}`
);
export const getPortalProfileUrl = () => `${getPortalBase()}/profile`;
export const getPortalRechargeUrl = () => `${getPortalBase()}/`;
export const getPortalInvitationUrl = () => `${getPortalBase()}/invitation`;
export const getPortalCreditsResetActivityUrl = () => `${getPortalBase()}/profile?activity=credits_reset`;
