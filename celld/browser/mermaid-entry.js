import mermaid from 'mermaid';

// Loaded only by wiki pages containing a Mermaid code fence. Author directives
// cannot relax these site-owned limits.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  secure: ['secure','securityLevel','startOnLoad','maxTextSize','suppressErrorRendering','maxEdges'],
  suppressErrorRendering: true,
  maxTextSize: 8192,
  maxEdges: 100,
  flowchart: { htmlLabels: false },
  theme: 'default',
});
window.mayflyMermaid = mermaid;
