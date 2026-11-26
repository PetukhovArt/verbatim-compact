---
type: regex
pattern: 'price\(\s*[^,()]+,\s*[''"]EUR[''"]\s*\)'
target: { source: file, path: src/invoice.ts }
weight: 2
---
