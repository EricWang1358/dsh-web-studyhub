/* "Show experimental features" (Settings › Advanced; lib/experimental.js): the one switch behind everything experimental. The snapshot carries it as
   `experimental`; every surface that could draw something experimental (today: Jev) asks here, and draws nothing unless it is a literal true. */
export const experimentalShown = data => data?.experimental === true;
