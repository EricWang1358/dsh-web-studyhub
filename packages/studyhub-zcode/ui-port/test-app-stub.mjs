// A stand-in for @modelcontextprotocol/ext-apps' App, used only by the --test build of the panel shell
// (scripts/build-zcode.mjs --test): the same interface (connect, readServerResource, callServerTool), over plain HTTP
// against packages/studyhub-zcode/scripts/test-panel-server.mjs. It lets a real browser run the production panel
// bundle before ZCode sees it. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

export class App {
  async connect() {}

  getHostContext() { return { displayMode: 'inline', availableDisplayModes: ['inline'] }; }

  async readServerResource({ uri }) {
    const name = String(uri).replace(/^ui:\/\/studyhub\//, '');
    const response = await fetch(`/ui/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`resource ${name}: HTTP ${response.status}`);
    return { contents: [{ uri, mimeType: 'text/plain', text: await response.text() }] };
  }

  async callServerTool({ name, arguments: parameters }) {
    const response = await fetch('/api/tool', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: parameters }),
    });
    return response.json();
  }
}
