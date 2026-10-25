import { t } from '../i18n';

/** MARC relator codes for the roles that come up for books and comics. */
export const ROLES: Record<string, string> = {
  aut: t('roles.aut'),
  edt: t('roles.edt'),
  trl: t('roles.trl'),
  ill: t('roles.ill'),
  art: t('roles.art'),
  clr: t('roles.clr'),
  cov: t('roles.cov'),
  nrt: t('roles.nrt'),
  ctb: t('roles.ctb'),
};

export const roleLabel = (role: string) => ROLES[role] ?? role;
