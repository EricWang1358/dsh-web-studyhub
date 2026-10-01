# StudyHub search extension

A companion bundle for [StudyHub](https://github.com/EricWang1358/dsh-web-studyhub). It lets StudyHub search large textbooks by topic: StudyHub's Settings and its "Large textbooks" card install it with one click, and build the index with one more.

It contains one small DSH plugin that mounts DSH's MCP client for [mcp-local-rag](https://github.com/shinpr/mcp-local-rag) (MIT, pinned in `package.json`). The server is started with the Node that DSH itself runs on and finds its files next to this package, so nothing in DSH's configuration is edited by hand, and no system Node, Python or Docker is needed. Index and model cache live under `<DSH home>/study/retrieval`.

The first index build downloads the embedding model (about 90 MB, per the server's documentation). The default model favours English; keyword matching still helps Chinese text. To download from another address, set `hfEndpoint` (an https URL) in `<DSH home>/study/retrieval.json`, which StudyHub's Settings also offers under Advanced; the server's documentation describes this as `HF_ENDPOINT`.

License: MIT.
