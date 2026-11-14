// データの型（docs/SPEC.md の 7.）。表と記録の型は段階1（データと同期）で足す。
// 段階0では、画面の操作の失敗を知らせる DomainError だけを置く（DS の段階0の src/domain/types.ts と同じ。src/store/uiStore.ts の attempt）

/** 決まりの上でできない操作（画面ではエラーのお知らせにする。src/store/uiStore.ts の attempt） */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainError'
  }
}
