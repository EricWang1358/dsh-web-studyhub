/* The library folder an outside agent's study-cli `--root` must name: the bound library, else the one the loaded data came from. `refs` is the app core's
   refs (any { bindingRoot, dataRef } pair does). One place, so 「发给主会话」 and the desktop 「在学习库里打开 CLI」 note never name different folders. */
export const libraryRootOf = (refs) => refs?.bindingRoot?.current || refs?.dataRef?.current?.root || '';
