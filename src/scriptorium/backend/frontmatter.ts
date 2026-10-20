/**
 * OKF frontmatter, read and written (E32, E35). The helper lives on the kit
 * path (`./kit/frontmatter.ts`, scriptorium-kit-keepers) so the cutover can
 * delete this file; until then the shipped backend reads it through here, so
 * both paths run one helper.
 */
export * from "./kit/frontmatter";
