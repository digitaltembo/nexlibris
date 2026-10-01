/** MARC relator codes for the roles that come up for books and comics. */
export const ROLES: Record<string, string> = {
  aut: 'Author',
  edt: 'Editor',
  trl: 'Translator',
  ill: 'Illustrator',
  art: 'Artist',
  clr: 'Colorist',
  cov: 'Cover artist',
  nrt: 'Narrator',
  ctb: 'Contributor',
};

export const roleLabel = (role: string) => ROLES[role] ?? role;
