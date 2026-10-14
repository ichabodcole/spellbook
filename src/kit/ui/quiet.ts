// The quiet fade: in a reading mode, idle chrome steps back until the pointer or
// the KEYBOARD focus reaches the bar it sits in. A bar opts in by carrying
// `QUIET_GROUP` while quiet; each part of it carries `QUIET_FADE`, unless that
// part is asking for attention (unsaved edits, a warning), which stays at full
// strength.
//
// Applied per part rather than to the whole bar, because opacity multiplies down
// the tree: a faded bar could not hold one part at full strength. Keyboard focus
// counts and a mouse click does not, since a click leaves focus behind on the
// control and would otherwise keep the bar loud.

/** On the bar: the group whose hover or keyboard focus brings its parts back. */
export const QUIET_GROUP = "group/chrome";

/** On a part of a quiet bar: faded back, and full strength again when the bar is reached. */
export const QUIET_FADE =
  "opacity-40 transition-opacity duration-300 group-hover/chrome:opacity-100 group-has-[:focus-visible]/chrome:opacity-100";
