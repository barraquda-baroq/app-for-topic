// Firebase の Web アプリの設定値（公開してよい識別子。データはアクセスルールで持ち主だけに限る。docs/SPEC.md の 3.・14.6）。
//
// TS の Firebase のプロジェクト topic-studio-1a463（NS・DS とは別。2026-11-14 までに作者が作った）の、Firebase のコンソールの
// 「プロジェクトの設定 → マイアプリ → SDK の設定と構成」の値（docs/DEPLOY.md の 1 の 7）。変える時は .firebaserc のプロジェクトもそろえる
export const firebaseConfig = {
  apiKey: 'AIzaSyDjn4BCnbtmCskU8LJYV2VcDZ3nbLJ9WYw',
  authDomain: 'topic-studio-1a463.firebaseapp.com',
  projectId: 'topic-studio-1a463',
  storageBucket: 'topic-studio-1a463.firebasestorage.app',
  messagingSenderId: '660422773523',
  appId: '1:660422773523:web:0b23c983d5a6e3651728e6',
}

/** 設定値がまだ仮の値のまま（docs/DEPLOY.md の手順で差し替える前） */
export const firebaseConfigIsPlaceholder = firebaseConfig.apiKey.startsWith('REPLACE_')

/** 開発・テスト用の Firebase エミュレーターのプロジェクト名（docs/DEPLOY.md の 7） */
export const EMULATOR_PROJECT_ID = 'demo-topic-studio'
