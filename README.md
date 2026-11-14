# Topic Studio

個人用のニュースアプリ（Web アプリ・PWA）。ニュースの一覧が最初から AI の要約になっていて、「だから何？」・AI の見解と対立見解・小学生にも分かる用語の注釈が付く。

- 仕様書: [docs/SPEC.md](docs/SPEC.md)
- 構成は Novel Studio・Diary Studio と同じ（React・TypeScript・Vite・Dexie・Firebase）。ニュースを集めて書くのは claude.ai の定期実行で、Claude 用のコネクタからアプリに足す。
- いまは作る前の段階（仕様書だけ）。

このリポジトリには、集めた記事・書いた要約などのニュースの中身は入れない（仕様書の 3.）。
