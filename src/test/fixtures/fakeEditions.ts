// 作り物の版（docs/SPEC.md の 16.3 の「作り物の版」）。単体テスト・偽のクラウド・エミュレーターに入れる道具・段階2の画面の見本で
// 同じ作り物を使う。
// - makeFakeEdition({ date, slot, seed }): 1つの枠の版と、その20本の話題と、辞書の束（その版で足した語。辞書がまだ空なので、使った語の全部）
// - makeFakeMonth({ until, days }): 何日分かの版。続報の鎖・作れなかった枠・時期で変わる語・訂正を含める（訂正も返す）
// - fakeRecordsOf: 記録を、コネクタが足す順（辞書の束 → 話題 → 版。作った時刻の順）に並べる（エミュレーターに入れる道具・偽のクラウド用）
// 返すのは記録（docs/SPEC.md の 7.1〜7.3 の型）。外側の文書（RecordDoc）は src/sync/codec.ts で作る（ここでは作らない）。
// id は src/domain/ids.ts で、段階3のコネクタと同じ作り方で作る（話題は中身の指紋、版は枠、訂正は話題の id と文の指紋）。
// 乱数は種から作り、Math.random・Date.now を使わない（同じ種からは同じ物。テストと段階2の画面の見本で同じ作り物を使うため）。
// 中身はすべて作り物（公開のリポジトリ・CI のログに本物を入れない。docs/SPEC.md の 3.）: 地名は「〇〇市」「△△県」「〇〇国」など、政党は
// 「A 党・B 党・C 党」、会社は「〇〇社」、社は作り物の一覧（src/test/fixtures/fakeOutlets.ts）、読んだ所は「××ニュース」、
// URL は https://example.com/… だけ。社の一覧は作り物の一覧なので、repairTopic・checkTopic には { outlets: FAKE_OUTLETS } を渡す。
import { cyrb53 } from '../../domain/hash'
import { correctionIdOf, editionFailIdOf, editionIdOf, termIdOf, termPackIdOf, topicIdOf } from '../../domain/ids'
import { addDaysToDate, isYmd, jstParts, slotTimeMs } from '../../domain/jst'
import { RECORD_LIMITS } from '../../domain/limits'
import {
  SLOT_VALUES,
  type Conclusion,
  type ConnectorTableName,
  type CorrectionRecord,
  type Edition,
  type EditionFail,
  type Emphasis,
  type FollowUp,
  type Genre,
  type NotChosen,
  type Region,
  type Slot,
  type SoWhat,
  type Source,
  type Stakeholder,
  type Stance,
  type TableRecords,
  type TermEntry,
  type TermPack,
  type TimelineEntry,
  type Topic,
  type TopicCheck,
  type TopicTerm,
  type ViewSection,
} from '../../domain/types'
import { FAKE_UNLISTED_OUTLET } from './fakeOutlets'

/** 作り物の記録の model（書いたモデル）と、照合の係の model（作り物の名前。本物のモデルの名前を使わない） */
export const FAKE_MODEL = 'fake-writer-model'
export const FAKE_CHECK_MODEL = 'fake-checker-model'
/** 読んだ所（作り物の「××ニュース」だけ。本物の配信の所の名前を使わない。docs/SPEC.md の 16.3） */
export const FAKE_VIA = '××ニュース'
/** 作り物の URL の頭（URL はこれで始まる物だけ） */
export const FAKE_URL_PREFIX = 'https://example.com/'

/**
 * 1つの版の中の、場面 → 順位（1〜20）。場面は docs/SPEC.md の 16.3 の「作り物の版」の一覧。1本の話題に場面が2つ以上ある時もある。
 * 種が変わっても、どの順位にどの場面があるかは変えない（テストが場面の話題を引けるように）
 */
export const FAKE_TOPIC_SCENES = {
  /** 重大印（いちばん上。docs/SPEC.md の 6.3）と速報・未確認 */
  major: 1,
  breaking: 1,
  /** 国の添え字の語「与党（米国）」・出典の via（××ニュース）・出典の日付だけの publishedAt */
  usRulingParty: 2,
  viaSource: 2,
  publishedDateOnly: 2,
  /** 国の添え字の語「与党（日本）」（makeFakeMonth では時期で変わる）・確かめられなかった当事者・立場の補足・経緯の when: null と年月だけ・論点 */
  jpRulingParty: 3,
  unverifiedStakeholder: 3,
  stanceNote: 3,
  timelineWhenNull: 3,
  timelineYearMonth: 3,
  viewIssue: 3,
  /** 見通しを「見通し」の言葉ごと強調する（docs/SPEC.md の 5.12）・soWhat.world の null */
  outlookEmphasis: 4,
  soWhatWorldNull: 4,
  /** soWhat.life の null・出典の publishedAt: null と補足 */
  soWhatLifeNull: 5,
  publishedAtNull: 5,
  /** AI のジャンル（AI 自身が当事者。docs/SPEC.md の 5.6） */
  aiGenre: 6,
  /** 同じ語句が欄に2回出る文（強調はその欄で最初に出る所に付く） */
  repeatedPhrase: 7,
  /** 理由つきの view.kind: 'none' */
  noneWithReason: 8,
  /** check: null（照合しなかった） */
  noCheck: 9,
  /** スポーツの view.kind: 'none'（理由は null）・結論の補足が空 */
  sportsNone: 10,
  emptyConclusionNote: 10,
  /** 強調の無い話題（emphasis: {}） */
  noEmphasis: 12,
  /** 上限いっぱいの長い文（RECORD_LIMITS の境目。強調も全体で60か所・各40字） */
  maxLength: 17,
  /** コネクタなら断る物（欄に無い語句・重なる語句・知らない鍵・null の欄の鍵）を入れた話題。アプリの repair が捨てて出す */
  connectorRejects: 19,
  /** 後の版のコネクタが作った記録: 知らない決まった値（genre: 'novel'・stance）・知らない欄・一覧に無い社のホストの URL（リンクにならない） */
  newerValues: 20,
} as const satisfies Record<string, number>

export type FakeTopicScene = keyof typeof FAKE_TOPIC_SCENES

/** 1つの版の作り物 */
export interface FakeEdition {
  edition: Edition
  /** 版の order の順（順位の順） */
  topics: Topic[]
  /** この版で足した語の束（辞書の今の形に無い語と、説明を新しくした語） */
  termPack: TermPack
  /** 場面 → 話題の id */
  scenes: Record<FakeTopicScene, string>
}

export interface FakeEditionOptions {
  /** 版の日付（'YYYY-MM-DD'。日本時間） */
  date: string
  slot: Slot
  /** 乱数の種（同じ種からは同じ物） */
  seed: string
}

/** 1つの枠の作り物の版（辞書が空の時の版。束には使った語が全部入る） */
export function makeFakeEdition(opts: FakeEditionOptions): FakeEdition {
  if (!isYmd(opts.date)) throw new RangeError(`版の日付は 'YYYY-MM-DD' にしてください（${opts.date}）`)
  const ym = opts.date.slice(0, 7)
  return buildEdition({
    ...opts,
    dict: new Map(),
    ruling: { jp: { rev: 1, asOf: ym, explanation: RULING_JP_EXPLANATIONS[0] }, usAsOf: ym },
  })
}

// ---------- 乱数（種から。mulberry32） ----------

interface FakeRng {
  /** 0 以上 1 未満 */
  next(): number
  /** min 以上 max 以下の整数 */
  int(min: number, max: number): number
  pick<T>(list: readonly T[]): T
  /** [0-9a-z] の n 字 */
  chars(n: number): string
}

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 種の文字列から乱数を作る（種の文字列は cyrb53 で数にする。Math.random を使わない） */
function fakeRng(seed: string): FakeRng {
  let a = (Number.parseInt(cyrb53(seed, 0x5eed), 36) % 4294967296) >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chars: (n) => Array.from({ length: n }, () => ALNUM[Math.floor(next() * ALNUM.length)]).join(''),
  }
}

// ---------- 用語の辞書（作り物の説明。docs/SPEC.md の 5.8・7.3） ----------

interface GlossaryItem {
  /** 見出しの表記（省くと key と同じ） */
  term?: string
  aliases?: string[]
  explanation: string
}

/**
 * 作り物の辞書（key → 語）。時期で変わる「与党（日本）」「与党（米国）」は、説明と時点を版ごとに決めるので、ここに置かない
 * （RULING_JP_EXPLANATIONS・RULING_US_EXPLANATION）。説明は小学生に分かるくらいのふつうの文（改行・URL・記法の記号を使わない）
 */
const GLOSSARY: Record<string, GlossaryItem> = {
  決済: { explanation: 'お金を払って、売り買いを終わらせることです。' },
  キャッシュレス: { explanation: '現金を使わずに、カードやスマホなどで払うことです。' },
  サーバー: { explanation: 'インターネットの向こうで、情報を預かったり送ったりするコンピューターです。' },
  復旧: { explanation: '止まったりこわれたりした物を、元どおりに戻すことです。' },
  障害: { explanation: '機械や仕組みが、うまく動かなくなることです。' },
  個人情報: { explanation: '名前や住所など、誰のことかが分かる情報です。' },
  報告書: { explanation: '調べたことや分かったことを、まとめた書類です。' },
  再発防止: { explanation: '同じことがもう一度起きないように、手を打つことです。' },
  現金: { explanation: 'お札や硬貨のお金です。' },
  スマホ: {
    aliases: ['スマートフォン'],
    explanation: '電話やインターネットが使える、手のひらに乗るくらいのコンピューターです。',
  },
  発表: { explanation: '決まったことや分かったことを、広く知らせることです。' },
  野党: { explanation: '政府をつくっていない政党です。政府のやり方を確かめたり、別の案を出したりします。' },
  法案: { explanation: '国会や議会で話し合う、新しい法律の案です。' },
  下院: { explanation: '米国などの議会にある2つの院のうちの1つです。予算の話し合いを先にすることが多いです。' },
  上院: { explanation: '米国などの議会にある2つの院のうちの1つです。法案は下院と上院の両方で認められる必要があります。' },
  大統領: { explanation: '国の代表で、政府のいちばん上に立つ人です。米国などでは選挙で選ばれます。' },
  署名: { explanation: '書類に自分の名前を書いて、認めたことを示すことです。' },
  インフラ: { explanation: '道路・橋・水道・電気など、暮らしや仕事の土台になる設備です。' },
  予算: { explanation: '1年でどれだけお金を使うかの計画です。' },
  可決: { explanation: '話し合いの結果、案を認めると決まることです。' },
  金利: { explanation: 'お金を借りた時に、借りた額に上乗せして払う割合です。' },
  衆議院: { aliases: ['衆院'], explanation: '国会にある2つの院のうちの1つです。もう1つは参議院です。' },
  国会: { explanation: '国の法律や予算を決める所です。衆議院と参議院があります。' },
  審議: { explanation: '案について、よいかどうかを話し合うことです。' },
  財源: { explanation: '使うお金を、どこから持ってくるかです。' },
  手当: { explanation: '国や会社などが、決まった人に配るお金です。' },
  委員会: { explanation: '決まった仕事のために、何人かが集まって話し合う会です。' },
  採決: { explanation: '賛成か反対かを決めるために、数を数えることです。' },
  物価: { explanation: 'いろいろな物やサービスの値段の、全体の高さです。' },
  家計: { explanation: '家庭のお金のやりくりです。' },
  賃上げ: { explanation: '働く人の給料を上げることです。' },
  ボーナス: { explanation: '毎月の給料とは別に、夏や冬などに払われるお金です。' },
  調査: { explanation: '物事のようすを調べて、確かめることです。' },
  見通し: { explanation: '先のことについての、今の見込みです。' },
  景気: { explanation: '物の売り買いやお金の動きが、活発かどうかのようすです。' },
  平均: { explanation: 'いくつかの数を足して、その数の個数で割った値です。' },
  業種: { explanation: '仕事の種類です。たとえば、物を作る仕事や、物を売る仕事などです。' },
  給料: { explanation: '働いた分として、会社などから払われるお金です。' },
  中央銀行: { explanation: '国のお金を出したり、金利を決めたりする特別な銀行です。' },
  政策金利: { explanation: '中央銀行が決める、もとになる金利です。ほかの金利もこれに合わせて動きます。' },
  利上げ: { explanation: '中央銀行が政策金利を上げることです。' },
  会合: { explanation: '何人かが集まって、話し合ったり決めたりすることです。' },
  為替: { explanation: '円とドルのように、違う国のお金を取りかえることです。' },
  雇用: { explanation: '人を雇って、働いてもらうことです。' },
  インフレ: { explanation: '物の値段が、全体として上がり続けることです。' },
  市場: { explanation: '物やお金の売り買いが行われる場の全体です。' },
  生成AI: { explanation: '文章や絵などを、新しく作り出す AI です。' },
  AI: { explanation: '人のように考えたり判断したりする仕組みを、コンピューターで作ったものです。' },
  規制: { explanation: 'きまりを作って、してよいことを限ることです。' },
  法律: { explanation: '国会などで決められた、国のきまりです。' },
  罰金: { explanation: 'きまりを破った時に、罰として払わせるお金です。' },
  誤情報: { explanation: 'まちがった情報です。' },
  消費者: { explanation: '物やサービスを買って使う人です。' },
  段階的: { explanation: '一度にではなく、少しずつ順番に進めることです。' },
  政府: { explanation: '国の政治を行う所です。' },
  議会: { explanation: '選ばれた人が集まって、きまりや予算を決める所です。' },
  市役所: { explanation: '市の仕事をする役所です。' },
  窓口: { explanation: '役所などで、来た人の手続きや相談を受ける所です。' },
  住民票: { explanation: '住んでいる所や家族を、市町村が記録した書類です。' },
  手続き: { explanation: '物事を決まった順番で進めるための、届け出などのことです。' },
  住民: { explanation: 'その地域に住んでいる人です。' },
  職員: { explanation: '役所などで働く人です。' },
  人手不足: { explanation: '仕事をする人が足りないことです。' },
  自治体: { explanation: '都道府県や市町村のように、地域の仕事をする役所のまとまりです。' },
  詐欺: { explanation: 'うそをついて、お金や物をだまし取ることです。' },
  容疑者: { explanation: '罪を犯した疑いがあると、警察などが見ている人です。犯人と決まったわけではありません。' },
  逮捕: { explanation: '警察などが、罪の疑いのある人を捕まえて、自由を一時的に止めることです。' },
  起訴: { explanation: '検察が、裁判で罪を問うと決めることです。' },
  検察: { explanation: '罪の疑いを調べて、裁判にかけるかを決める役所です。' },
  警察: { explanation: '事件を調べたり、町の安全を守ったりする役所です。' },
  被害: { explanation: '事件や事故などで、損をしたりけがをしたりすることです。' },
  受け取り役: { explanation: 'だまし取ったお金やカードを、受け取りに行く役目の人です。' },
  高齢者: { explanation: '年を取った人です。ふつうは65歳以上の人をいいます。' },
  裁判: { explanation: '裁判所が、法律にもとづいて争いや罪を決めることです。' },
  脱線: { explanation: '列車の車輪が、レールから外れることです。' },
  線路: { explanation: '列車が走るためのレールと、その下の土台です。' },
  点検: { explanation: '悪い所がないか、ひとつずつ調べることです。' },
  乗客: { explanation: '乗り物に乗っている客です。' },
  区間: { explanation: 'ある所からある所までの間です。' },
  原因: { explanation: '物事が起きたもとになったことです。' },
  設備: { explanation: 'ある目的のために備えた、機械や建物などです。' },
  鉄道: { explanation: 'レールの上を列車が走る乗り物と、その仕組みです。' },
  日本代表: { explanation: '国際的な大会に、日本を代表して出るチームや選手です。' },
  決勝: { explanation: '大会で、優勝を決める最後の試合です。' },
  優勝: { explanation: '大会でいちばんになることです。' },
  セット: { explanation: 'バレーボールなどで、試合を区切ったひとまとまりです。' },
  フルセット: { explanation: '決められたセットを、最後まで全部戦うことです。' },
  主将: { aliases: ['キャプテン'], explanation: 'チームのまとめ役の選手です。' },
  合宿: { explanation: '何日か同じ所に泊まって、練習することです。' },
  世界大会: { explanation: '世界の国や地域のチームが集まって戦う大会です。' },
  接戦: { explanation: '点の差が少なく、どちらが勝つか分からない戦いです。' },
  大会: { explanation: 'たくさんのチームや人が集まって、競い合う会です。' },
  選手: { explanation: '試合や競技に出る人です。' },
  ビデオ判定: { explanation: '映像を見直して、審判の判定を確かめる仕組みです。' },
  審判: { explanation: '試合で、きまりが守られているかを見て、判定する人です。' },
  判定: { explanation: 'きまりにもとづいて、どちらかを決めることです。' },
  リーグ: { explanation: 'いくつかのチームが集まって、決まった間に試合をする仕組みです。' },
  来季: { explanation: '次のシーズンです。' },
  費用: { explanation: '何かをするのにかかるお金です。' },
  試合: { explanation: 'チームや人が、決まったきまりで勝ち負けを競うことです。' },
  ファン: { explanation: 'ある人やチーム、作品などを好きで応援する人です。' },
  映像: { explanation: 'カメラで写した、動く絵です。' },
  制度: { explanation: '社会の中で決められた、仕組みやきまりです。' },
  興行収入: { explanation: '映画館などで、入場券が売れて入ったお金の合計です。' },
  配給: { explanation: '映画を映画館に届けて、上映してもらう仕事です。' },
  舞台: { explanation: 'お話の出来事が起きる場所です。' },
  アニメ: { explanation: '絵を少しずつ動かして作った映像の作品です。' },
  公開: { explanation: '映画などを、多くの人が見られるようにすることです。' },
  商店街: { explanation: 'お店がたくさん並んでいる通りです。' },
  聖地巡礼: { explanation: '好きな作品の舞台になった場所を、ファンが訪ねることです。' },
  駐車: { explanation: '車を止めておくことです。' },
  地元: { explanation: 'その場所に住んでいる人や、その地域です。' },
  観光: { explanation: 'ほかの土地を訪ねて、景色や名所を楽しむことです。' },
  配信: { explanation: 'インターネットで、動画や音楽を届けることです。' },
  作り手: { explanation: '曲や作品を作る人です。' },
  値上げ: { explanation: '値段を上げることです。' },
  料金: { explanation: '物を使ったりサービスを受けたりした時に払うお金です。' },
  本社: { explanation: '会社の中心になる事務所です。' },
  大手: { explanation: '同じ仕事の中で、特に大きな会社です。' },
  取り分: { explanation: '分けた時に、自分がもらう分です。' },
  著作権: { explanation: '曲や文章を作った人が持つ、使い方を決める権利です。' },
  定額: { explanation: '使った量に関係なく、決まった額を払うことです。' },
  水道料金: { explanation: '水道の水を使った分として払うお金です。' },
  水道管: { explanation: '水を家などに届けるための管です。' },
  市議会: { explanation: '市のきまりや予算を話し合って決める集まりです。' },
  負担: { explanation: '自分で引き受けて払うお金や、背負う苦労です。' },
  税: { explanation: '国や自治体が、みんなのための仕事に使うために集めるお金です。' },
  老朽化: { explanation: '古くなって、傷んだり弱くなったりすることです。' },
  議決: { explanation: '話し合いで、多い方の意見に決めることです。' },
  人工衛星: { explanation: '地球のまわりを回る、人が打ち上げた機械です。' },
  インターネット: {
    aliases: ['ネット'],
    explanation: '世界中のコンピューターをつないで、情報をやりとりする仕組みです。',
  },
  通信: { explanation: '電話やインターネットで、情報をやりとりすることです。' },
  電波: { explanation: '目に見えない波で、遠くまで情報を届けるのに使います。' },
  宇宙のごみ: { explanation: '使い終わった人工衛星やその部品など、宇宙を飛び回るごみです。' },
  周波数: { explanation: '電波の種類を分ける数です。国が使い道を割り当てます。' },
  打ち上げ: { explanation: 'ロケットで、人工衛星などを宇宙へ送ることです。' },
  災害: { explanation: '地震・大雨・台風などで、大きな被害が出ることです。' },
  国境: { explanation: '国と国との境目です。' },
  合意: { explanation: '話し合って、意見が一つにまとまることです。' },
  上流: { explanation: '川の、水が流れてくる方です。' },
  下流: { explanation: '川の、水が流れていく方です。' },
  農業: { explanation: '田や畑で作物を育てたり、家畜を飼ったりする仕事です。' },
  承認: { explanation: 'よいと認めることです。' },
  割合: { explanation: '全体の中で、ある部分がどれだけかを示した数です。' },
  緊張: { explanation: 'ここでは、国どうしの間がぴりぴりして、争いになりそうなようすです。' },
  交渉: { explanation: '相手と話し合って、取り決めをまとめようとすることです。' },
  条約: { explanation: '国どうしが結ぶ、文書にした約束です。' },
  出どころ: { explanation: '情報や話が出てきた元です。' },
  透明性: { explanation: '中で何をしているかが、外から分かるようになっていることです。' },
  検索: { explanation: 'たくさんの情報の中から、目当ての物を探すことです。' },
  学習データ: { explanation: 'AI が覚えるために読む、たくさんの文章や画像です。' },
  指摘: { explanation: '大事な点や悪い点を、取り上げて示すことです。' },
  記事: { explanation: '新聞やニュースのサイトなどに載る、出来事を伝える文章です。' },
  仕組み: { explanation: '物事が動くための、組み立てやきまりです。' },
  充電: { explanation: '電池に電気をためることです。' },
  差し込み口: { explanation: '線をさしこむための穴です。' },
  タブレット: { explanation: '画面にさわって使う、板のような形のコンピューターです。' },
  規格: { explanation: '形や大きさなどを、そろえるために決めたきまりです。' },
  電子ごみ: { explanation: '捨てられたスマホや充電の線など、電気で動く物のごみです。' },
  対象: { explanation: '決まりなどが当てはまる相手や物です。' },
  互換性: { explanation: 'ちがう機械どうしでも、同じように使えることです。' },
  図書館: { explanation: '本を集めて、みんなが読んだり借りたりできる所です。' },
  童話: { explanation: '子どものために書かれたお話です。' },
  延滞: { explanation: '返す日を過ぎても、返さないままでいることです。' },
  展示: { explanation: '物を並べて、多くの人に見せることです。' },
  郵便: { explanation: '手紙や荷物を届ける仕組みです。' },
  送り主: { explanation: '物を送った人です。' },
  返却: { explanation: '借りた物を返すことです。' },
  // 続報の鎖（〇〇市の新しい橋。makeFakeMonth）
  通行料: { explanation: '道や橋を通る時に払うお金です。' },
  渋滞: { explanation: '車が多くて、道がなかなか進まないことです。' },
  歩道: { explanation: '人が歩くための道の部分です。' },
  住宅地: { explanation: '家がたくさん集まっている所です。' },
  中心部: { explanation: '町のまん中の、店や役所が多い所です。' },
  維持費: { explanation: 'ものを使い続けるためにかかるお金です。' },
  修繕: { explanation: 'こわれた所を直すことです。' },
  開通: { explanation: '新しい道や橋などが、通れるようになることです。' },
  交通量: { explanation: '道を通る車や人の数です。' },
  通行止め: { explanation: '道や橋を、しばらく通れなくすることです。' },
  迂回: { explanation: '遠回りして行くことです。' },
  抜け道: { explanation: '大きな道をさけて通る、細い道です。' },
}

/** 時期で変わる語「与党（日本）」の説明（rev 1・rev 2。makeFakeMonth の途中で rev 2 になり、asOf が上がる。docs/SPEC.md の 5.8・7.3） */
export const RULING_JP_KEY = '与党（日本）'
const RULING_JP_EXPLANATIONS = [
  '国の政治で、政府をつくっている政党です。いまは A 党です。',
  '国の政治で、政府をつくっている政党です。いまは A 党と B 党が組んでいます。',
] as const
/** 国の添え字で分けた、もう1つの「与党」 */
export const RULING_US_KEY = '与党（米国）'
const RULING_US_EXPLANATION = '米国で、大統領と同じ政党です。議会で多数とは限りません。'

interface RulingState {
  jp: { rev: number; asOf: string; explanation: string }
  usAsOf: string
}

/** 辞書の語（コネクタが付ける termId・rev。docs/SPEC.md の 7.3） */
function glossaryEntry(key: string, ruling: RulingState): TermEntry {
  if (key === RULING_JP_KEY)
    return {
      termId: termIdOf(key),
      key,
      term: '与党',
      aliases: [],
      explanation: ruling.jp.explanation,
      asOf: ruling.jp.asOf,
      rev: ruling.jp.rev,
    }
  if (key === RULING_US_KEY)
    return {
      termId: termIdOf(key),
      key,
      term: '与党',
      aliases: [],
      explanation: RULING_US_EXPLANATION,
      asOf: ruling.usAsOf,
      rev: 1,
    }
  const item = GLOSSARY[key]
  if (!item) throw new Error(`作り物の辞書に「${key}」がありません`)
  return {
    termId: termIdOf(key),
    key,
    term: item.term ?? key,
    aliases: [...(item.aliases ?? [])],
    explanation: item.explanation,
    asOf: null,
    rev: 1,
  }
}

// ---------- 話題の下書き ----------

/** 出典の下書き（url は組み立てる所で https://example.com/… を作る） */
interface SourceDraft {
  outlet: string
  title: string
  via?: string | null
  /** 省くと、版の日付のその回より前の日時（日本時間） */
  publishedAt?: string | null
  publishedNote?: string | null
  /** 省くと作り物の URL（https://example.com/…） */
  url?: string
  /** 知らない欄（後の版のコネクタが足した欄の見本） */
  extra?: Record<string, unknown>
}

/** 当事者の下書き（stance は知らない値も入れられる） */
type StakeholderDraft = Omit<Stakeholder, 'stance'> & { stance: Stance | string }

/** 話題の下書き（id・共通の欄・用語の写し・URL は組み立てる所で付ける） */
interface TopicDraft {
  region: Region | string
  genre: Genre | string
  major?: boolean
  rankReason: string
  headline: string
  summary: string
  conclusion: Conclusion
  soWhat: SoWhat
  stakeholders?: StakeholderDraft[]
  view: ViewSection
  timeline: TimelineEntry[]
  followUp?: FollowUp | null
  /** 続報の threadId（前の話題の threadId。コネクタが写す。docs/SPEC.md の 7.8 の「続報のつなぎ」）。続報でなければ自分の id */
  threadId?: string
  terms: TermEntry[]
  sources: SourceDraft[]
  /** 出典の社のあとに並べる、ほかの社（outletNames の後ろ） */
  moreOutlets?: string[]
  unverified?: string[]
  /** 省くと作り物の照合の件数 */
  check?: TopicCheck | null
  emphasis: Emphasis
  /** 知らない欄（後の版のコネクタが足した欄の見本） */
  extra?: Record<string, unknown>
}

/** 下書きを作る時の手がかり（地名・日付は種と版の日付から） */
interface Ctx {
  rng: FakeRng
  editionId: string
  date: string
  slot: Slot
  /** 版の日付の日（「15日」の 15） */
  day: number
  year: number
  /** 版の日付の前の月（'YYYY-MM'） */
  prevYm: string
  /** 国内の作り物の地名 */
  city: string
  pref: string
  /** 世界の作り物の国の名前（2つは違う国） */
  country: string
  country2: string
  /** 辞書の語（key の並び → 辞書の語） */
  terms(keys: readonly string[]): TermEntry[]
}

type Story = (c: Ctx) => TopicDraft

const CITIES = ['〇〇市', '△△市', '□□市'] as const
const PREFS = ['△△県', '〇〇県'] as const
const COUNTRIES = ['〇〇国', '△△国', '□□国'] as const

const settled = (note: string): Conclusion => ({ label: 'settled', note, breaking: false })
const unsettled = (note: string): Conclusion => ({ label: 'unsettled', note, breaking: false })
const opposed = (axis: string, aiView: string, counterView: string, issue: string | null = null): ViewSection => ({
  kind: 'opposed',
  axis,
  issue,
  aiView,
  counterView,
})

/** 前の月（'YYYY-MM'） */
const prevMonthOf = (date: string): string => addDaysToDate(`${date.slice(0, 8)}01`, -1).slice(0, 7)

// ---------- 20本の話題（順位の順。docs/SPEC.md の 16.3 の「作り物の版」） ----------

/** 1位: 重大印・速報（国内・テクノロジー）。正しい強調（要約・だから何？・経緯の大事な行だけ・AI の見解と対立見解で同じ数） */
const majorOutage: Story = (c) => {
  const h = c.rng.int(3, 6)
  const at = c.slot === '12' ? c.rng.int(6, 8) : c.rng.int(13, 15)
  const n = c.rng.int(120, 480)
  return {
    region: 'jp',
    genre: 'tech',
    major: true,
    rankReason: '全国の多くの人の支払いが止まり、暮らしと仕事に広く響いたため',
    headline: `スマホ決済の〇〇社で大規模な障害、全国の店やネットで約${h}時間使えず`,
    summary: `スマホで払う〇〇社の決済が${c.day}日の${at}時ごろから約${h}時間止まり、全国の店やネットの買い物で使えなくなった。会社はサーバーを新しくする作業の手順に誤りがあったと説明し、その後に復旧した。使えなかった支払いは約${n}万件とみられる。個人情報が漏れたかどうかは、まだ分かっていない。会社は月内に原因の報告書をまとめるとしている。`,
    conclusion: { label: 'unsettled', note: '止まって復旧したことは確定、情報が漏れたかどうかは未確認', breaking: true },
    soWhat: {
      life: 'スマホ決済だけに頼っていた人は、その間は買い物や支払いができませんでした。現金や別のカードを少し持っておくと、こうした時に困りにくくなります。',
      system:
        '決済の会社には、大きな障害が起きた時に国へ報告する決まりがあります。国は報告を受けて、会社に再発防止の計画を求めることができます。',
      world: '（一般的な傾向）キャッシュレスが広がった国ほど、決済が止まった時の暮らしへの影響は大きくなります。',
      whyNews: 'キャッシュレスで払う人が増え、決済が止まると暮らしの多くの場面に響くためです。',
    },
    view: opposed(
      '推進（便利さ） ⇔ 慎重（安全・プライバシー）',
      '支払いをスマホにまとめる便利さは大きく、今回の障害だけで流れを止める理由にはならないように見えます。会社が原因と対策を早く示せば、使う人の信頼は戻ると考えます。',
      '1つの会社の仕組みに頼りすぎると、止まった時の影響が大きすぎるように見えます。現金や別の払い方を残すことを、国や店もあわせて考えるべきだと考えます。',
    ),
    timeline: [
      { when: c.date, text: `${at}時ごろ、〇〇社の決済が使えなくなった` },
      { when: c.date, text: `約${h}時間後に復旧したと会社が発表した` },
      { when: null, text: 'その後、会社が月内に報告書をまとめる予定' },
    ],
    terms: c.terms([
      '決済',
      'キャッシュレス',
      'サーバー',
      '復旧',
      '障害',
      '個人情報',
      '報告書',
      '再発防止',
      '現金',
      'スマホ',
      '発表',
    ]),
    sources: [
      { outlet: '〇〇通信', title: '〇〇社のスマホ決済で障害、全国で使えず' },
      { outlet: '△△新聞', title: 'スマホ決済が数時間止まる 作業の手順に誤り' },
      { outlet: '□□放送', title: '〇〇社の決済が復旧 原因の報告書を月内に' },
    ],
    unverified: ['個人情報が漏れたかどうかは確かめられなかった', '使えなかった支払いの正確な件数は確かめられなかった'],
    emphasis: {
      summary: [`約${h}時間止まり`, 'まだ分かっていない'],
      'conclusion.note': ['漏れたかどうかは未確認'],
      'soWhat.life': ['支払いができませんでした'],
      'soWhat.system': ['国へ報告する決まり'],
      'view.aiView': ['流れを止める理由にはならない'],
      'view.counterView': ['止まった時の影響が大きすぎる'],
      'timeline.1.text': [`約${h}時間後に復旧`],
    },
  }
}

/** 2位: 世界・政治。国の添え字の語「与党（米国）」・出典の via（××ニュース）と日付だけの publishedAt */
const usBill: Story = (c) => ({
  region: 'world',
  genre: 'politics',
  rankReason: '世界の大きな経済の国の予算の行方で、ほかの国の商売にも響きうるため',
  headline: '米国の下院でインフラ予算を増やす法案が可決、上院で通るかはまだ見えず',
  summary: `米国の議会の下院で${c.day}日、古い道路や橋を直すインフラの予算を増やす法案が可決された。与党の A 党が賛成し、野党の B 党は反対した。法案は次に上院で話し合われる。上院では B 党が多数を占めており、成立するかはまだ分からない。大統領は、成立すれば署名するとしている。`,
  conclusion: unsettled('下院の可決は確定、上院で成立するかは未確定'),
  soWhat: {
    life: null,
    system: '米国では、法案が下院と上院の両方で可決され、大統領が署名すると法律になります。',
    world: '（一般的な傾向）米国が道路や橋に大きなお金を使うと、建設の資材を売る国の商売にも響きます。',
    whyNews: '古い道路や橋が米国で長く課題になっており、予算の額も大きいためです。',
  },
  stakeholders: [
    {
      name: 'A 党',
      stance: 'for',
      stanceNote: null,
      claim: '古い道路や橋を早く直すために、予算を増やすべきだと主張している。',
      reason: '事故や渋滞を減らし、仕事も生むため。',
    },
    {
      name: 'B 党',
      stance: 'against',
      stanceNote: null,
      claim: '国の借金が増えるので、今は予算を増やすべきではないと主張している。',
      reason: '将来の世代の負担が重くなるため。',
    },
  ],
  view: opposed(
    '政府・与党側 ⇔ 野党・批判側',
    '古い橋や道路は、直すのが遅れるほど事故の心配と直す費用が増えるように見えます。今のうちに予算を増やす考えには、筋が通っていると考えます。',
    '借金を増やして予算をふくらませると、将来の金利や税の負担が重くなるように見えます。直す所を絞り、ほかの予算を削るべきだと考えます。',
    '論点は「古い設備を早く直す」か「国の借金を抑える」か',
  ),
  timeline: [
    { when: c.prevYm, text: '与党の A 党が法案を下院に出した' },
    { when: c.date, text: '下院で法案が可決された' },
    { when: null, text: 'その後、上院で話し合われる予定' },
  ],
  terms: c.terms([RULING_US_KEY, '野党', '法案', '下院', '上院', '大統領', '署名', 'インフラ', '予算', '可決', '金利']),
  sources: [
    { outlet: '〇〇通信', title: '米下院、インフラ予算を増やす法案を可決' },
    { outlet: FAKE_UNLISTED_OUTLET, via: FAKE_VIA, title: '米国の法案、上院の行方は見えず', publishedAt: c.date },
    { outlet: '□□放送', title: '米国の下院で法案可決 与党と野党の主張は' },
  ],
  moreOutlets: ['△△新聞'],
  unverified: [],
  emphasis: {
    summary: ['法案が可決された', '成立するかはまだ分からない'],
    'soWhat.system': ['両方で可決され'],
    'stakeholders.0.claim': ['予算を増やすべき'],
    'stakeholders.1.claim': ['予算を増やすべきではない'],
    'view.aiView': ['今のうちに予算を増やす'],
    'view.counterView': ['ほかの予算を削るべき'],
    'timeline.1.text': ['下院で法案が可決'],
  },
})

/**
 * 3位: 国内・政治。国の添え字の語「与党（日本）」（makeFakeMonth では途中で説明が新しくなる）・確かめられなかった当事者（claim: null）・
 * 立場の補足・経緯の when: null と年月だけ・論点。主張のある当事者すべてに同じ数の強調
 */
const jpBill: Story = (c) => {
  const k = c.rng.int(3, 9)
  return {
    region: 'jp',
    genre: 'politics',
    rankReason: '子育ての家庭の暮らしに直接かかわり、成立の時期が近いため',
    headline: '子育ての手当を増やす法案が衆議院で審議入り、財源の示し方が焦点に',
    summary: `子育ての家庭に配る手当を増やす法案が${c.day}日、衆議院で審議に入った。与党は今の国会のうちに成立させたい考えだ。手当は子ども1人あたり月${k}千円増える案で、始める時期はまだ決まっていない。野党の一部は、財源の示し方が足りないとして修正を求めている。審議は来週から委員会で続く。`,
    conclusion: unsettled('審議入りは確定、成立するかと始める時期は未確定'),
    soWhat: {
      life: `子どもが1人いる家庭なら、案のとおりに決まれば手当が月${k}千円増えます。始める時期はまだ決まっていません。`,
      system: '法案は衆議院と参議院の両方で可決されると、法律になります。手当のお金は国の予算から出ます。',
      world: null,
      whyNews: '物価が上がって家計の負担が重くなる中で、子育ての支え方に関心が集まっているためです。',
    },
    stakeholders: [
      {
        name: 'A 党',
        stance: 'for',
        stanceNote: null,
        claim: '手当を増やして、子育ての家庭をすぐに助けるべきだと主張している。',
        reason: '物価が上がり、家計の負担が重くなっているため。',
      },
      {
        name: 'B 党',
        stance: 'conditional',
        stanceNote: '財源が示されれば賛成',
        claim: '財源をはっきり示したうえで、手当を増やすべきだと主張している。',
        reason: '将来の世代に借金を残さないため。',
      },
      { name: 'C 党', stance: 'unknown', stanceNote: null, claim: null, reason: null },
    ],
    view: opposed(
      '政府・与党側 ⇔ 野党・批判側',
      '物価が上がる中では、手当を早く増やすことが、子育ての家庭の助けになるように見えます。財源の議論は、始めた後も続けられると考えます。',
      '財源をはっきりさせないまま手当を増やすと、将来の負担を先に送るように見えます。始める前に、どこからお金を出すかを示すべきだと考えます。',
      '論点は「家計をすぐ助ける」か「財政と将来の負担を重く見る」か',
    ),
    timeline: [
      { when: c.prevYm, text: '政府が手当を増やす方針を決めた' },
      { when: c.date, text: '衆議院で法案の審議が始まった' },
      { when: null, text: 'その後、委員会で採決する予定' },
    ],
    terms: c.terms([RULING_JP_KEY, '野党', '法案', '衆議院', '国会', '審議', '財源', '手当', '委員会', '採決', '物価', '家計']),
    sources: [
      { outlet: '〇〇通信', title: '子育ての手当を増やす法案、衆院で審議入り' },
      { outlet: '△△新聞', title: '手当の法案、財源の示し方が焦点に' },
      { outlet: '□□放送', title: '子育て手当の法案 与野党の主張は', publishedAt: c.date },
    ],
    unverified: ['C 党の主張は確かめられなかった'],
    emphasis: {
      summary: ['衆議院で審議に入った', '始める時期はまだ決まっていない'],
      'soWhat.life': [`手当が月${k}千円増えます`],
      'stakeholders.0.claim': ['すぐに助けるべき'],
      'stakeholders.1.claim': ['財源をはっきり示した'],
      'view.aiView': ['手当を早く増やすこと'],
      'view.counterView': ['将来の負担を先に送る'],
      'timeline.1.text': ['審議が始まった'],
    },
  }
}

/** 4位: 国内・経済。結論は見通し、見通しを「見通し」の言葉ごと強調・soWhat.world の null */
const bonusOutlook: Story = (c) => {
  const p = c.rng.int(2, 9)
  const n = c.rng.int(30, 60)
  return {
    region: 'jp',
    genre: 'economy',
    rankReason: '県内の多くの働く人の家計にかかわる数字のため',
    headline: `${c.pref}の会社の冬のボーナス、平均で去年より${p}%増える見通しと県が発表`,
    summary: `${c.pref}が${c.day}日に発表した調べで、県内の会社の冬のボーナスは平均${n}万円となり、去年より${p}%増える見通しになった。春からの賃上げが広がったためだという。ただ、物価の上がり方に給料が追いつくかは分からない。県は来月、業種ごとのくわしい結果をまとめるとしている。`,
    conclusion: { label: 'outlook', note: '調べの数字は確定、実際に払われる額は見通しの段階', breaking: false },
    soWhat: {
      life: 'ボーナスが増えても、食べ物や電気の値段も上がっているので、使えるお金がその分だけ増えるとは限りません。',
      system: '県の調べは、会社に答えてもらった物を集めた数字で、県内のすべての会社が入っているわけではありません。',
      world: null,
      whyNews: '物価が上がる中で、給料がそれに追いつくかどうかに関心が集まっているためです。',
    },
    view: opposed(
      '楽観 ⇔ 悲観',
      '賃上げが県内の多くの会社に広がったことは、景気が上向く手がかりになるように見えます。この流れが来年も続けば、暮らしにも効いてくると考えます。',
      '平均の数字が増えても、物価の上がり方に追いつかなければ、暮らしは楽にならないように見えます。小さな会社まで広がるかを見るべきだと考えます。',
    ),
    timeline: [
      { when: String(c.year), text: '春の賃上げが県内の会社にも広がった' },
      { when: c.date, text: '県が冬のボーナスの見通しを発表した' },
    ],
    terms: c.terms(['賃上げ', '物価', 'ボーナス', '調査', '見通し', '景気', '平均', '業種', '給料', '発表', '家計']),
    sources: [
      { outlet: '△△新聞', title: `${c.pref}の冬のボーナス、平均${p}%増の見通し` },
      { outlet: '〇〇通信', title: '県内の冬のボーナス 賃上げが広がる' },
    ],
    unverified: ['小さな会社の数字がどれだけ入っているかは確かめられなかった'],
    emphasis: {
      summary: [`去年より${p}%増える見通し`, '追いつくかは分からない'],
      'conclusion.note': ['払われる額は見通しの段階'],
      'soWhat.life': ['増えるとは限りません'],
      'view.aiView': ['景気が上向く手がかり'],
      'view.counterView': ['暮らしは楽にならない'],
      'timeline.1.text': ['ボーナスの見通し'],
    },
  }
}

const RATES = ['3.5', '4.0', '4.25', '4.5'] as const

/** 5位: 世界・経済。soWhat.life の null・出典の publishedAt: null と補足 */
const rateHike: Story = (c) => {
  const r = c.rng.pick(RATES)
  const k = c.rng.int(2, 4)
  return {
    region: 'world',
    genre: 'economy',
    rankReason: '大きな国の金利の動きで、為替や世界のお金の流れに響きうるため',
    headline: `${c.country}の中央銀行が政策金利を${r}%に引き上げ、今年に入って${k}回目`,
    summary: `${c.country}の中央銀行は${c.day}日、政策金利を${r}%に引き上げると決めた。物価の上がり方が強いためで、利上げは今年に入って${k}回目になる。銀行が家や車のお金を貸す時の金利も上がる見込みだ。中央銀行は、次の会合でさらに上げるかは、物価のようすを見て決めるとしている。`,
    conclusion: settled('利上げは確定、次の会合で上げるかは未定'),
    soWhat: {
      life: null,
      system: '中央銀行は、金利を上げ下げして、お金の借りやすさを変え、物価の上がり方をおさえます。',
      world: '（一般的な傾向）大きな国の利上げは、ほかの国のお金の流れや為替の値動きにも響きます。',
      whyNews: '物価の上がり方が強い中で、利上げがどこまで続くかが注目されているためです。',
    },
    view: opposed(
      '物価の安定を重く見る ⇔ 景気と雇用を重く見る',
      '物価の上がり方が強いうちは、利上げを続けて早めにおさえることが、暮らしを守る近道のように見えます。今回の判断は理にかなっていると考えます。',
      '利上げを急ぐと、お金を借りにくくなって会社の仕事が減り、働く人の暮らしが苦しくなるように見えます。次の利上げは慎重に決めるべきだと考えます。',
    ),
    timeline: [
      { when: c.prevYm, text: '前の会合で利上げを決めた' },
      { when: c.date, text: `政策金利を${r}%に引き上げた` },
    ],
    terms: c.terms(['中央銀行', '政策金利', '利上げ', '金利', '物価', '会合', '為替', '景気', '雇用', 'インフレ', '市場']),
    sources: [
      { outlet: '〇〇通信', title: `${c.country}が利上げ、政策金利${r}%に` },
      {
        outlet: '□□放送',
        title: `${c.country}の中央銀行 今年${k}回目の利上げ`,
        publishedAt: null,
        publishedNote: '掲載日時は記事に書かれていなかった',
      },
    ],
    unverified: [],
    emphasis: {
      summary: [`${r}%に引き上げる`, '物価のようすを見て決める'],
      'conclusion.note': ['次の会合で上げるかは未定'],
      'soWhat.world': ['為替の値動きにも響きます'],
      'view.aiView': ['早めにおさえる'],
      'view.counterView': ['会社の仕事が減り'],
      'timeline.1.text': [`${r}%に引き上げた`],
    },
  }
}

/** 6位: 世界・AI（AI 自身が当事者のジャンル） */
const aiLaw: Story = (c) => {
  const m = c.rng.int(6, 18)
  return {
    region: 'world',
    genre: 'ai',
    rankReason: 'AI の使い方を決める大きな国の法律で、ほかの国の決まりの目安になりうるため',
    headline: `${c.country}で生成AIの規制法が成立、作った文や画像に印を付ける義務`,
    summary: `${c.country}の議会で${c.day}日、生成AIの使い方を決める法律が成立した。AI が作った文や画像には、AI が作ったと分かる印を付けることが会社に求められる。守らない会社には罰金を科す。法律は${m}か月後から段階的に始まる。どこまでの AI が対象になるかの細かい決まりは、これから政府が作る。`,
    conclusion: settled('法律の成立は確定、対象の細かい決まりはこれから'),
    soWhat: {
      life: `${c.country}で使われる AI のサービスでは、AI が作った画像などに印が付くようになります。日本で使う人にも、同じ形が広がる可能性があります。`,
      system: '会社は、AI が作った物に印を付ける仕組みを用意する必要があります。守らない会社には罰金を科す決まりです。',
      world: '（一般的な傾向）大きな市場を持つ国の決まりは、ほかの国の会社の作り方にも影響します。',
      whyNews: 'AI が作った画像や文が広がり、本物と見分けにくくなっているためです。',
    },
    stakeholders: [
      {
        name: `${c.country}の大手の AI の会社`,
        stance: 'conditional',
        stanceNote: '細かい決まりしだい',
        claim: '印を付けること自体には賛成だが、細かい決まりは使いやすさに配慮すべきだと主張している。',
        reason: '新しいサービスを出しにくくなるため。',
      },
      {
        name: `${c.country}の消費者の団体`,
        stance: 'for',
        stanceNote: null,
        claim: '印を付ける義務は、誤情報から人を守るために欠かせないと主張している。',
        reason: '本物と見分けられない画像が増えているため。',
      },
    ],
    view: opposed(
      '推進（恩恵） ⇔ 慎重（リスク・雇用）',
      'AI が作った物に印を付ける決まりは、使う人が自分で見分ける助けになるように見えます。AI の便利さを生かしながら、信頼を守る形だと考えます。',
      '印は外したり消したりできるので、決まりだけで誤情報は防げないように見えます。会社の負担が増えて、新しい AI が育ちにくくなると考えます。',
    ),
    timeline: [
      { when: String(c.year - 1), text: '政府が AI の規制の案を出した' },
      { when: c.date, text: '議会で法律が成立した' },
      { when: null, text: `その後、${m}か月後から段階的に始まる` },
    ],
    terms: c.terms(['生成AI', 'AI', '規制', '法律', '罰金', '誤情報', '消費者', '段階的', '政府', '議会', '市場']),
    sources: [
      { outlet: '〇〇通信', title: `${c.country}で生成AIの規制法が成立` },
      { outlet: '△△新聞', title: 'AI が作った物に印 罰金つきの法律' },
    ],
    unverified: [],
    emphasis: {
      summary: ['印を付けることが会社に求められる', 'これから政府が作る'],
      'stakeholders.0.claim': ['使いやすさに配慮すべき'],
      'stakeholders.1.claim': ['誤情報から人を守る'],
      'view.aiView': ['見分ける助けになる'],
      'view.counterView': ['誤情報は防げない'],
      'timeline.1.text': ['法律が成立した'],
    },
  }
}

/** 7位: 国内・AI。同じ語句（「AI の案内」）が要約に2回出る（強調は最初に出る所に付く） */
const aiDesk: Story = (c) => {
  const langs = c.rng.int(5, 9)
  return {
    region: 'jp',
    genre: 'ai',
    rankReason: '役所の窓口で AI を使う身近な例で、住民の手続きにかかわるため',
    headline: `${c.city}が市役所の窓口に AI の案内、来月から${langs}つの言葉で受け付け`,
    summary: `${c.city}は来月から、市役所の窓口に AI の案内を置くと${c.day}日に発表した。AI の案内は${langs}つの言葉で、住民票などの手続きの順番を教える。市によると、窓口で待つ時間を半分ほどに減らす狙いがある。答えをまちがえた時の対応や、話した内容をどこまで残すかは、まだ決めていない。`,
    conclusion: unsettled('置くことは確定、話した内容の残し方は未定'),
    soWhat: {
      life: `${c.city}に住む人は、窓口で待つ時間が短くなる見込みです。日本語が得意でない人も、手続きの順番を聞きやすくなります。`,
      system: '市役所の仕事の一部を AI が手伝う形で、決めるのは今までどおり市の職員です。',
      world: null,
      whyNews: '人手が足りない役所で、AI をどう使うかが各地で課題になっているためです。',
    },
    view: opposed(
      '推進（恩恵） ⇔ 慎重（リスク・雇用）',
      '窓口の待ち時間が減り、いろいろな言葉で聞けるのは、住民にとって大きな助けになるように見えます。職員は、むずかしい相談に時間を使えると考えます。',
      'AI の答えがまちがっていた時に、誰が責任を持つかがはっきりしないように見えます。話した内容の残し方を決めてから始めるべきだと考えます。',
    ),
    timeline: [
      { when: c.prevYm, text: '市が窓口で AI を試した' },
      { when: c.date, text: '来月から置くと市が発表した' },
    ],
    terms: c.terms(['AI', '市役所', '窓口', '住民票', '手続き', '住民', '職員', '個人情報', '人手不足', '自治体', '発表']),
    sources: [
      { outlet: '△△新聞', title: `${c.city}、窓口に AI の案内` },
      { outlet: '□□放送', title: '市役所の窓口で AI が手続きを案内' },
    ],
    unverified: ['話した内容を残すかどうかの市の案は確かめられなかった'],
    emphasis: {
      summary: ['AI の案内', 'まだ決めていない'],
      'soWhat.life': ['待つ時間が短くなる見込み'],
      'view.aiView': ['大きな助けになる'],
      'view.counterView': ['誰が責任を持つか'],
      'timeline.1.text': ['来月から置く'],
    },
  }
}

/** 8位: 国内・事件。理由つきの view.kind: 'none'。疑いの段階を言葉ごと強調し、捜査側の見方は強調しない（docs/SPEC.md の 5.9・5.12） */
const fraudArrest: Story = (c) => {
  const age = c.rng.pick([70, 80] as const)
  const n = c.rng.int(2, 9)
  const a = c.rng.int(20, 39)
  const cases = c.rng.int(30, 90)
  return {
    region: 'jp',
    genre: 'incident',
    rankReason: '高齢の人をねらった詐欺が続き、身近に注意が要るため',
    headline: `うその電話で高齢の人からお金をだまし取った疑い、${c.pref}警察が男を逮捕`,
    summary: `${c.pref}警察は${c.day}日、息子をよそおったうその電話で、${c.city}に住む${age}代の女性から現金${n}百万円をだまし取った疑いで、${a}歳の男を逮捕した。警察は、男が受け取り役だったとみて、指示した人がいないかを調べている。県内では今年、同じような被害が${cases}件あったという。`,
    conclusion: unsettled('逮捕は確定、男が罪を犯したかは裁判などで決まる'),
    soWhat: {
      life: '家族を名乗る電話でお金の話が出たら、一度電話を切り、ふだんの番号にかけ直して確かめると被害を防ぎやすくなります。',
      system: '逮捕は罪が決まったことではありません。警察と検察が調べ、起訴するかどうかを検察が決めます。',
      world: null,
      whyNews: '高齢の人をねらった電話の詐欺が各地で続き、被害の額も大きいためです。',
    },
    view: { kind: 'none', noneReason: '捜査の段階の事実を伝える報道で、評価が分かれる論点がまだ無いため' },
    timeline: [
      { when: null, text: '先月、女性の家にうその電話がかかってきた' },
      { when: c.date, text: '警察が男を逮捕した' },
    ],
    terms: c.terms(['詐欺', '容疑者', '逮捕', '起訴', '検察', '警察', '被害', '受け取り役', '高齢者', '現金', '裁判']),
    sources: [
      { outlet: '△△新聞', title: `うその電話で${n}百万円 だまし取った疑いで男を逮捕` },
      { outlet: '〇〇通信', title: `${c.pref}警察、受け取り役とみて調べ` },
    ],
    unverified: ['男が逮捕の後に何と話しているかは確かめられなかった'],
    emphasis: {
      summary: ['だまし取った疑い', `同じような被害が${cases}件`],
      'conclusion.note': ['裁判などで決まる'],
      'soWhat.life': ['一度電話を切り'],
      'soWhat.system': ['起訴するかどうか'],
      'timeline.1.text': ['男を逮捕した'],
    },
  }
}

/** 9位: 世界・事故。check: null（照合しなかった） */
const derailment: Story = (c) => {
  const n = c.rng.int(10, 40)
  const p = c.rng.int(2, 6) * 100
  return {
    region: 'world',
    genre: 'incident',
    rankReason: '多くの人が使う路線の事故で、古い設備の課題が問われているため',
    headline: `${c.country}で列車が脱線、乗客${n}人がけが、古い線路の点検が焦点に`,
    summary: `${c.country}の東部で${c.day}日、乗客およそ${p}人を乗せた列車が脱線し、${n}人がけがをした。命にかかわるけがの人はいないという。国の鉄道の会社は、線路のゆがみが原因の可能性があるとみて調べている。この区間では、線路を直す工事が予算の不足で遅れていたと報じられている。`,
    conclusion: unsettled('脱線とけが人の数は確定、原因は調べている段階'),
    soWhat: {
      life: null,
      system: '国の鉄道の会社が原因を調べ、結果は国の事故の調査の委員会にも報告されます。',
      world: '（一般的な傾向）線路などの古い設備を直すお金が足りない国では、同じような事故が起きやすくなります。',
      whyNews: '多くの人が使う路線での事故で、古い設備を直す予算が足りないと前から言われていたためです。',
    },
    view: opposed(
      '仕組みの問題 ⇔ 個人の責任',
      '直す工事が予算の不足で遅れていたなら、一人の判断よりも、設備にお金を回す仕組みの問題が大きいように見えます。国が予算の配り方を見直すべきだと考えます。',
      '原因がまだ分からないうちは、運転や点検をした人の判断も含めて、一つずつ確かめるべきように見えます。仕組みのせいだと決めるのは、まだ早いと考えます。',
    ),
    timeline: [
      { when: String(c.year - 2), text: '線路を直す工事の計画が決まった' },
      { when: null, text: 'その後、予算の不足で工事が遅れた' },
      { when: c.date, text: '列車が脱線し、乗客がけがをした' },
    ],
    terms: c.terms(['脱線', '線路', '点検', '乗客', '区間', '原因', '予算', '調査', '設備', '鉄道', '委員会']),
    sources: [
      { outlet: '〇〇通信', title: `${c.country}で列車脱線、${n}人けが` },
      { outlet: '□□放送', title: '脱線の区間 工事の遅れが報じられる' },
    ],
    unverified: ['工事が遅れた理由が予算の不足だけかは確かめられなかった'],
    check: null,
    emphasis: {
      summary: [`${n}人がけがをした`, 'みて調べている'],
      'view.aiView': ['設備にお金を回す仕組み'],
      'view.counterView': ['一つずつ確かめるべき'],
      'timeline.2.text': ['列車が脱線'],
    },
  }
}

/** 10位: 国内・スポーツ。view.kind: 'none'（理由は null）・soWhat の life と world の null・結論の補足が空 */
const volleyFinal: Story = (c) => {
  const s = c.rng.int(15, 19)
  return {
    region: 'jp',
    genre: 'sports',
    rankReason: '日本代表の優勝で、来年の世界大会にもつながるため',
    headline: `バレーボールの〇〇杯で日本代表が優勝、決勝で${c.country}にフルセット勝ち`,
    summary: `${c.city}で開かれたバレーボールの〇〇杯で${c.day}日、日本代表が決勝で${c.country}をセットカウント3対2で破り、2大会ぶりに優勝した。最後のセットは${s}対${s - 2}の接戦だった。大会で最も活躍した選手には、日本代表の主将が選ばれた。日本代表は来年の世界大会に向けて、来月から合宿に入る。`,
    conclusion: settled(''),
    soWhat: {
      life: null,
      system: null,
      world: null,
      whyNews: '日本代表が2大会ぶりに優勝し、来年の世界大会に向けた力を示したためです。',
    },
    view: { kind: 'none', noneReason: null },
    timeline: [
      { when: String(c.year - 4), text: '前に〇〇杯で優勝した' },
      { when: c.date, text: '決勝で勝ち、2大会ぶりに優勝した' },
    ],
    terms: c.terms(['日本代表', '決勝', '優勝', 'セット', 'フルセット', '主将', '合宿', '世界大会', '接戦', '大会', '選手']),
    sources: [
      { outlet: '□□放送', title: '日本代表が〇〇杯で優勝' },
      { outlet: '△△新聞', title: `決勝は${s}対${s - 2}の接戦 日本代表が逆転で頂点` },
    ],
    moreOutlets: ['〇〇通信'],
    unverified: [],
    emphasis: {
      summary: ['2大会ぶりに優勝'],
      'soWhat.whyNews': ['2大会ぶりに優勝'],
      'timeline.1.text': ['優勝した'],
    },
  }
}

/** 11位: 世界・スポーツ。評価の余地がある制度の話題なので、対立見解がある */
const videoReview: Story = (c) => ({
  region: 'world',
  genre: 'sports',
  rankReason: '判定の仕組みを大きく変える決定で、ほかの国のリーグにも広がりうるため',
  headline: `${c.country}のサッカーの1部リーグ、来季から全試合でビデオ判定を使う`,
  summary: `${c.country}のサッカーの1部リーグは${c.day}日、来季から全ての試合でビデオ判定を使うと決めた。これまでは一部の試合だけだった。審判の判定の誤りを減らすためで、費用はリーグが出す。一方で、試合が止まる時間が長くなるとの声もあり、使う場面の細かい決まりはこれから作る。`,
  conclusion: settled('全試合で使うことは確定、使う場面の決まりはこれから'),
  soWhat: {
    life: null,
    system: 'ビデオ判定では、別の部屋の審判が映像を見直し、試合の審判に知らせます。最後に決めるのは試合の審判です。',
    world: null,
    whyNews: '判定の誤りで勝ち負けが変わったとされる試合が続き、ファンの関心が高かったためです。',
  },
  view: opposed(
    '制度の評価（正確さ ⇔ 試合の流れ）',
    '判定の誤りで結果が変わるのを減らせるなら、全試合に広げる意味は大きいように見えます。選手もファンも、結果を受け入れやすくなると考えます。',
    '映像を見直すたびに試合が止まると、サッカーらしい流れが失われるように見えます。使う場面をしぼり、時間の上限を決めるべきだと考えます。',
  ),
  timeline: [
    { when: String(c.year - 3), text: '一部の試合でビデオ判定を使い始めた' },
    { when: c.date, text: '来季から全試合で使うと決めた' },
  ],
  terms: c.terms(['ビデオ判定', '審判', '判定', 'リーグ', '来季', '費用', '試合', 'ファン', '映像', '制度', '選手']),
  sources: [
    { outlet: '〇〇通信', title: `${c.country}リーグ、全試合でビデオ判定へ` },
    { outlet: '△△新聞', title: 'ビデオ判定を全試合に 試合の流れを心配する声も' },
  ],
  unverified: [],
  emphasis: {
    summary: ['全ての試合でビデオ判定を使う', 'これから作る'],
    'view.aiView': ['判定の誤りで結果が変わる'],
    'view.counterView': ['サッカーらしい流れ'],
    'timeline.1.text': ['全試合で使う'],
  },
})

/** 12位: 国内・エンタメ。強調の無い話題（emphasis: {}。コネクタは「要約に強調が無い」を知らせる） */
const animeHit: Story = (c) => {
  const w = c.rng.int(3, 8)
  const n = c.rng.int(20, 60)
  return {
    region: 'jp',
    genre: 'entertainment',
    rankReason: '町のにぎわいと住む人の暮らしの両方にかかわる話題のため',
    headline: `${c.city}が舞台のアニメ映画、公開${w}週で興行収入${n}億円を超える`,
    summary: `${c.city}が舞台のアニメ映画が、公開から${w}週で興行収入${n}億円を超えたと、配給の会社が${c.day}日に発表した。映画に出てくる商店街や駅には、休みの日に多くのファンが訪れている。市は、ファンが増えたことで、ゴミや止める所の無い車が増えていることへの対策を考えている。`,
    conclusion: settled('興行収入の数字は確定'),
    soWhat: {
      life: `${c.city}の舞台になった所の近くでは、休みの日に人や車が増えています。行く時は電車やバスを使うと、地元の人の迷惑になりにくくなります。`,
      system: null,
      world: null,
      whyNews: 'アニメの舞台の町をファンが訪ねる動きが広がり、町のにぎわいと困りごとの両方が話題になっているためです。',
    },
    view: opposed(
      '町のにぎわい ⇔ 住む人の暮らし',
      '映画をきっかけに人が訪れるのは、町にとって大きなにぎわいのチャンスに見えます。案内や駐車の場所を整えれば、良い形で続くと考えます。',
      '人が急に増えると、ゴミや車で住む人の暮らしが乱されるように見えます。にぎわいよりも、住む人の声を先に聞くべきだと考えます。',
    ),
    timeline: [
      { when: addDaysToDate(c.date, -7 * w), text: '映画が公開された' },
      { when: c.date, text: `興行収入が${n}億円を超えた` },
    ],
    terms: c.terms(['興行収入', '配給', '舞台', 'アニメ', '公開', '商店街', 'ファン', '聖地巡礼', '駐車', '地元', '観光']),
    sources: [
      { outlet: '□□放送', title: `${c.city}が舞台のアニメ映画、興行収入${n}億円` },
      { outlet: FAKE_UNLISTED_OUTLET, via: FAKE_VIA, title: '舞台の町にファン ゴミや車の対策も' },
    ],
    unverified: [],
    emphasis: {},
  }
}

/** 13位: 世界・エンタメ。主張のある当事者すべてに同じ数の強調 */
const musicPrice: Story = (c) => {
  const p = c.rng.int(1, 3)
  return {
    region: 'world',
    genre: 'entertainment',
    rankReason: '日本で使う人の料金も上がり、多くの人にかかわるため',
    headline: `${c.country}の音楽の配信の大手、来月から月の料金を${p}割ほど上げると発表`,
    summary: `${c.country}に本社がある音楽の配信の大手は${c.day}日、来月から月の料金を${p}割ほど上げると発表した。日本で使う人の料金も上がる。会社は、曲を作る人に払うお金を増やすためだと説明している。料金を上げた分のうち、どれだけが作り手に届くかは、まだ示していない。`,
    conclusion: settled('料金を上げることは確定、作り手に届く額は示されていない'),
    soWhat: {
      life: `この配信を使っている人は、来月から月の支払いが${p}割ほど増えます。家族で使う形の料金も上がります。`,
      system: '配信の会社は、曲が聞かれた回数などに応じて、作り手や音楽の会社にお金を払っています。',
      world: null,
      whyNews: '音楽を配信で聞く人が多く、料金の値上げが多くの人に関わるためです。',
    },
    stakeholders: [
      {
        name: '配信の会社',
        stance: 'for',
        stanceNote: null,
        claim: '作り手に払うお金を増やすために、料金を上げる必要があると主張している。',
        reason: '曲を作る人が続けられるようにするため。',
      },
      {
        name: '作り手の団体',
        stance: 'conditional',
        stanceNote: '届く額が示されれば賛成',
        claim: '値上げの分のうち、どれだけが作り手に届くかを示すべきだと主張している。',
        reason: '今の分け方では、作り手の取り分が少ないため。',
      },
    ],
    view: opposed(
      '作り手 ⇔ 受け手',
      '曲を作る人に払うお金を増やす目的なら、少しの値上げは受け入れられるように見えます。作り手が続けられれば、聞く人にも良い曲が届くと考えます。',
      '作り手に届く額が示されないままでは、会社のもうけを増やすだけになるように見えます。値上げの前に、分け方を明らかにするべきだと考えます。',
    ),
    timeline: [
      { when: String(c.year - 1), text: '前の値上げをした' },
      { when: c.date, text: '来月からの値上げを発表した' },
    ],
    terms: c.terms(['配信', '作り手', '値上げ', '料金', '本社', '大手', '取り分', '著作権', '定額', '発表', 'ファン']),
    sources: [
      { outlet: '〇〇通信', title: `音楽の配信の大手、料金を${p}割上げ` },
      { outlet: '△△新聞', title: '配信の値上げ 作り手に届く額は' },
    ],
    unverified: ['値上げの分のうち作り手に届く額は確かめられなかった'],
    emphasis: {
      summary: [`${p}割ほど上げる`, '示していない'],
      'soWhat.life': [`${p}割ほど増えます`],
      'stakeholders.0.claim': ['料金を上げる必要がある'],
      'stakeholders.1.claim': ['どれだけが作り手に届くか'],
      'view.aiView': ['受け入れられる'],
      'view.counterView': ['もうけを増やすだけ'],
      'timeline.1.text': ['値上げを発表'],
    },
  }
}

/** 14位: 国内・経済（makeFakeMonth の続報の鎖の版では、この順位が鎖の話題になる） */
const waterRate: Story = (c) => {
  const p = c.rng.int(10, 20)
  const yen = c.rng.int(3, 6) * 100 + 50
  return {
    region: 'jp',
    genre: 'economy',
    rankReason: '市に住む人の毎月の支払いにかかわり、全国の課題にも通じるため',
    headline: `${c.city}が水道料金を来年4月から平均${p}%上げる案、古い水道管の交換のため`,
    summary: `${c.city}は${c.day}日、水道料金を来年4月から平均${p}%上げる案を示した。古くなった水道管を取りかえる費用が足りないためだという。4人の家庭なら、月の料金は約${yen}円増える。案は来月の市議会で話し合われ、認められれば決まる。市は、暮らしの苦しい家庭への手当ても考えるとしている。`,
    conclusion: unsettled('案を示したことは確定、上げるかは市議会で決まる'),
    soWhat: {
      life: `${c.city}に住む4人の家庭なら、来年4月から水道料金が月に約${yen}円増える見込みです。`,
      system: '水道料金は市が案を作り、市議会が認めると決まります。水道は料金で費用をまかなうのが基本です。',
      world: null,
      whyNews: '古い水道管が各地で増え、取りかえの費用をどうまかなうかが全国の課題になっているためです。',
    },
    view: opposed(
      '料金でまかなう ⇔ 税でまかなう',
      '古い水道管を放っておくと、水が止まる事故が増えるように見えます。使う人が料金で少しずつ負担するのは、筋の通った形だと考えます。',
      '水は暮らしに欠かせないので、料金を上げると苦しい家庭ほど負担が重くなるように見えます。税で一部をまかなう道も考えるべきだと考えます。',
    ),
    timeline: [
      { when: String(c.year - 1), text: '市が水道管の古さを調べた' },
      { when: c.date, text: '料金を上げる案を示した' },
      { when: null, text: 'その後、市議会で話し合われる予定' },
    ],
    terms: c.terms(['水道料金', '水道管', '市議会', '費用', '負担', '家計', '税', '値上げ', '老朽化', '自治体', '議決']),
    sources: [
      { outlet: '△△新聞', title: `${c.city}、水道料金を平均${p}%上げる案` },
      { outlet: '□□放送', title: '古い水道管の交換 料金の値上げで' },
    ],
    unverified: [],
    emphasis: {
      summary: [`平均${p}%上げる案`, '認められれば決まる'],
      'soWhat.life': [`約${yen}円増える見込み`],
      'view.aiView': ['水が止まる事故が増える'],
      'view.counterView': ['苦しい家庭ほど負担が重く'],
      'timeline.1.text': ['料金を上げる案'],
    },
  }
}

/** 15位: 世界・テクノロジー */
const satelliteNet: Story = (c) => {
  const p = c.rng.int(3, 8)
  return {
    region: 'world',
    genre: 'tech',
    rankReason: '電波の届かない所をなくす新しい通信の形で、各国が注目しているため',
    headline: `${c.country}が人工衛星を使ったネットの通信を始める、山や海でもつながる`,
    summary: `${c.country}の通信の大手は${c.day}日、人工衛星を使ったインターネットの通信を始めると発表した。地上の電波が届かない山や海でも、スマホがつながるようになるという。料金は月に${p}千円ほどからで、まずは国の北部から始める。打ち上げる人工衛星の数が増えると、宇宙のごみが増えるとの心配もある。`,
    conclusion: settled('始めることは確定、ほかの地域に広げる時期は未定'),
    soWhat: {
      life: '（一般的な傾向）同じような仕組みが日本でも広がれば、山登りや船の上でもスマホが使えるようになります。',
      system: '人工衛星の電波を使うには、国の許しが必要です。周波数という電波の通り道を、国が割り当てます。',
      world: '（一般的な傾向）宇宙を使った通信は、国どうしの競争になっており、打ち上げの数が増えています。',
      whyNews: '電波の届かない所をなくす新しい通信の形として、各国で注目されているためです。',
    },
    view: opposed(
      '推進（便利さ） ⇔ 慎重（安全・プライバシー）',
      '山や海でもつながれば、災害の時や遠い地域の暮らしに大きく役立つように見えます。新しい通信の形として、広げていく価値があると考えます。',
      '人工衛星が増えすぎると、宇宙のごみが増えて、ほかの衛星にぶつかる危険が高まるように見えます。打ち上げの数の決まりを先に作るべきだと考えます。',
    ),
    timeline: [
      { when: c.prevYm, text: '人工衛星の打ち上げを始めた' },
      { when: c.date, text: '通信を始めると発表した' },
    ],
    terms: c.terms([
      '人工衛星',
      'インターネット',
      '通信',
      '電波',
      '宇宙のごみ',
      '周波数',
      '打ち上げ',
      '料金',
      '災害',
      '大手',
      'スマホ',
    ]),
    sources: [
      { outlet: '〇〇通信', title: `${c.country}、人工衛星でネットの通信` },
      { outlet: '△△新聞', title: '山や海でもスマホがつながる 宇宙のごみの心配も' },
    ],
    unverified: [],
    emphasis: {
      summary: ['山や海でも、スマホがつながる', '宇宙のごみが増える'],
      'view.aiView': ['大きく役立つ'],
      'view.counterView': ['ぶつかる危険が高まる'],
      'timeline.1.text': ['通信を始める'],
    },
  }
}

/** 16位: 世界・政治（国どうしの当事者） */
const riverDeal: Story = (c) => ({
  region: 'world',
  genre: 'politics',
  rankReason: '長く続いた国どうしの争いに区切りがつく可能性があるため',
  headline: `${c.country}と${c.country2}が国境の川の水の分け方で合意、長い争いに区切り`,
  summary: `${c.country}と${c.country2}は${c.day}日、国境を流れる川の水の分け方について合意した。雨の少ない年でも、決まった割合で水を分ける。2つの国は、この川の水をめぐって長く争ってきた。合意は、それぞれの国の議会で認められた後に始まる。${c.country2}の議会では反対の声もあり、認められるかはまだ分からない。`,
  conclusion: unsettled('合意は確定、議会で認められるかは未確定'),
  soWhat: {
    life: null,
    system: '国どうしの約束は、それぞれの国の議会などで認められて、はじめて動き出します。',
    world: '水の争いが続く地域で、話し合いで分け方を決めた例になり、ほかの川の争いにも参考になる可能性があります。',
    whyNews: '水をめぐる争いが長く続き、2つの国の間の緊張の一つになっていたためです。',
  },
  stakeholders: [
    {
      name: c.country,
      stance: 'for',
      stanceNote: null,
      claim: '決まった割合で分ければ、雨の少ない年でも農業を続けられると主張している。',
      reason: '国の東部の畑が川の水に頼っているため。',
    },
    {
      name: c.country2,
      stance: 'conditional',
      stanceNote: '議会の承認しだい',
      claim: '合意は前進だが、上流で水を使う量の決まりも必要だと主張している。',
      reason: '上流の使い方しだいで、下流の水が減るため。',
    },
  ],
  view: opposed(
    '協調 ⇔ 自国の利益',
    '長く争ってきた水の分け方を話し合いで決めたことは、地域を落ち着かせる大きな一歩に見えます。細かい点は、始めながら直していけると考えます。',
    '決まった割合で分けると、雨の少ない年に自分の国の水が足りなくなるおそれがあるように見えます。議会がよく確かめてから認めるべきだと考えます。',
  ),
  timeline: [
    { when: String(c.year - 10), text: '川の水をめぐる争いが強まった' },
    { when: c.date, text: '2つの国が水の分け方で合意した' },
    { when: null, text: 'その後、それぞれの議会で話し合われる予定' },
  ],
  terms: c.terms(['国境', '合意', '議会', '上流', '下流', '農業', '承認', '割合', '緊張', '交渉', '条約']),
  sources: [
    { outlet: '〇〇通信', title: `${c.country}と${c.country2}、川の水の分け方で合意` },
    { outlet: '□□放送', title: '国境の川の合意 議会の承認が焦点' },
  ],
  unverified: [],
  emphasis: {
    summary: ['合意した', '認められるかはまだ分からない'],
    'stakeholders.0.claim': ['農業を続けられる'],
    'stakeholders.1.claim': ['上流で水を使う量の決まり'],
    'view.aiView': ['大きな一歩'],
    'view.counterView': ['水が足りなくなるおそれ'],
    'timeline.1.text': ['水の分け方で合意'],
  },
})

/** 18位: 世界・AI */
const aiSources: Story = (c) => ({
  region: 'world',
  genre: 'ai',
  rankReason: 'AI の誤情報を減らす試みで、ほかの会社の作り方の目安になりうるため',
  headline: `${c.country}の大手が AI の答えに出どころを示す仕組み、誤情報を減らす狙い`,
  summary: `${c.country}の大手の会社は${c.day}日、AI が答える時に、どの記事やページを元にしたかを示す仕組みを始めると発表した。AI の誤情報を減らす狙いがある。示された出どころが本当に答えの元になっているかは、外から確かめにくいとの指摘もある。まずは${c.country}の言葉から始め、日本語でも使えるようにするという。`,
  conclusion: settled('仕組みを始めることは確定、日本語で始める時期は未定'),
  soWhat: {
    life: 'AI の答えの出どころが分かれば、使う人が元のページを開いて確かめやすくなります。',
    system: 'AI の会社が自分で決めた仕組みで、国の決まりで求められた物ではありません。',
    world: '（一般的な傾向）大手の会社の仕組みは、ほかの会社の AI の作り方の目安になりやすいです。',
    whyNews: 'AI のまちがった答えが広がることへの心配が、世界で強まっているためです。',
  },
  view: opposed(
    '推進（恩恵） ⇔ 慎重（リスク・雇用）',
    '出どころが示されれば、使う人が AI の答えを確かめる習慣が広がるように見えます。誤情報を減らす一歩として、意味があると考えます。',
    '出どころが本当に元になったかを確かめる方法が無いと、かえって答えを信じこませるように見えます。外の人が確かめられる形にするべきだと考えます。',
  ),
  timeline: [
    { when: c.prevYm, text: 'AI のまちがった答えが問題になった' },
    { when: c.date, text: '出どころを示す仕組みを発表した' },
  ],
  terms: c.terms(['AI', '生成AI', '誤情報', '出どころ', '透明性', '大手', '検索', '学習データ', '指摘', '記事', '仕組み']),
  sources: [
    { outlet: '△△新聞', title: 'AI の答えに出どころ 大手が新しい仕組み' },
    { outlet: FAKE_UNLISTED_OUTLET, via: FAKE_VIA, title: '出どころを示す AI 確かめにくいとの声も' },
  ],
  unverified: ['示された出どころが答えの元になっているかは確かめられなかった'],
  emphasis: {
    summary: ['元にしたかを示す', '外から確かめにくい'],
    'soWhat.life': ['確かめやすくなります'],
    'view.aiView': ['確かめる習慣が広がる'],
    'view.counterView': ['かえって答えを信じこませる'],
    'timeline.1.text': ['出どころを示す仕組み'],
  },
})

/**
 * 19位: 世界・テクノロジー。コネクタなら断る強調（docs/SPEC.md の 7.1 の「コネクタが断る」）を入れた話題: 欄に無い語句（要約）・
 * 重なる語句（soWhat.life）・知らない鍵（headline。見出しには付けられない）・null の欄の鍵（soWhat.world）。
 * アプリの repairTopic は、それらを捨てて、合う語句（要約の1つ目・soWhat.life の1つ目・見解と対立見解）だけで出す
 */
const chargerRule: Story = (c) => ({
  region: 'world',
  genre: 'tech',
  rankReason: '新しいスマホの充電の形がそろい、ほかの国にも広がりうるため（強調の確かめ用の作り物）',
  headline: `${c.country}でスマホの充電の差し込み口を1つの形にそろえる決まりが始まる`,
  summary: `${c.country}で${c.day}日、新しく売るスマホやタブレットの充電の差し込み口を、1つの形にそろえる決まりが始まった。機械ごとに充電の線を買い直す手間と、捨てられる線のごみを減らす狙いがある。すでに売られている物は対象にならない。ほかの国にも同じ決まりが広がるかは、まだ分からない。`,
  conclusion: settled('決まりが始まったことは確定'),
  soWhat: {
    life: `${c.country}で売られる新しいスマホなら、1本の充電の線で、ほかの機械も充電できるようになります。`,
    system: '国が売ってよい機械の決まりを作り、守らない物は売れなくなります。',
    world: null,
    whyNews: '充電の線のごみが多く、機械ごとに形が違う不便さが長く言われてきたためです。',
  },
  view: opposed(
    '決まりでそろえる ⇔ 会社の工夫に任せる',
    '差し込み口がそろえば、線を買い直す手間とごみが減り、使う人の得が大きいように見えます。国が決まりでそろえる意味はあると考えます。',
    '形を決まりで固めると、もっと良い差し込み口を作る工夫が出にくくなるように見えます。会社どうしの話し合いに任せるべきだと考えます。',
  ),
  timeline: [
    { when: String(c.year - 2), text: '国が差し込み口をそろえる決まりを作った' },
    { when: c.date, text: '決まりが始まった' },
  ],
  terms: c.terms(['充電', '差し込み口', 'タブレット', '規格', '電子ごみ', '規制', '対象', '消費者', '互換性', 'スマホ', '政府']),
  sources: [
    { outlet: '〇〇通信', title: `${c.country}、充電の差し込み口をそろえる決まり` },
    { outlet: '□□放送', title: 'スマホの充電の形が1つに 線のごみを減らす' },
  ],
  unverified: [],
  emphasis: {
    summary: ['決まりが始まった', 'この語句は要約に無い'],
    headline: ['差し込み口'],
    'soWhat.life': ['1本の充電の線', '充電の線で'],
    'soWhat.world': ['ほかの国'],
    'view.aiView': ['手間とごみが減り'],
    'view.counterView': ['工夫が出にくくなる'],
  },
})

/**
 * 20位: 後の版のコネクタが作った記録の見本。知らない決まった値（genre: 'novel'（D20 の小説のネタ）・stance: 'neutral'）・知らない欄
 * （話題の storySeed・出典の paywall）・一覧に無い社（◇◇日報）の、読んだ所の無い出典（今の一覧ではホストが分からないので、リンクにせず文として出す）。
 * コネクタの今の確かめでは断られる（genre・stance・URL）。アプリは消さずに残し、総合にだけ出す（docs/SPEC.md の 7.1 の「決まった値と決まった文」）
 */
const libraryBook: Story = (c) => ({
  region: 'jp',
  genre: 'novel',
  rankReason: '心が温まる出来事で、多くの人の関心を集めたため',
  headline: `${c.city}の図書館に50年前に借りられた本が返る、はさまれていた手紙も`,
  summary: `${c.city}の図書館に、50年前に借りられたままだった童話の本が、郵便で返ってきた。本には「長い間ごめんなさい」と書かれた手紙がはさまれていた。送り主の名前は書かれておらず、図書館は返ってきた本を、来月の展示で紹介するとしている。延滞の料金は取らないという。`,
  conclusion: settled('本が返ってきたことは確定'),
  soWhat: {
    life: null,
    system: null,
    world: null,
    whyNews: '50年という長い時間と、手紙の言葉に心を動かされた人が多いためです。',
  },
  stakeholders: [
    {
      name: '図書館',
      stance: 'neutral',
      stanceNote: null,
      claim: '本が返ってきたことを喜び、来月の展示で紹介したいとしている。',
      reason: '多くの人に本の歩みを知ってほしいため。',
    },
  ],
  view: { kind: 'none', noneReason: null },
  timeline: [
    { when: String(c.year - 50), text: '本が借りられた' },
    { when: c.date, text: '本が郵便で返ってきた' },
  ],
  terms: c.terms(['図書館', '童話', '延滞', '展示', '郵便', '送り主', '返却', '住民', '職員', '発表', '記事']),
  sources: [
    { outlet: '△△新聞', title: '50年ぶりに本が返る 手紙も', extra: { paywall: false } },
    { outlet: FAKE_UNLISTED_OUTLET, title: '図書館に50年前の本 送り主は分からず' },
  ],
  unverified: ['送り主が誰かは確かめられなかった'],
  emphasis: {
    summary: ['50年前に借りられたまま'],
    'stakeholders.0.claim': ['展示で紹介したい'],
  },
  extra: { storySeed: { theme: '50年の間に本がたどった道', hints: ['手紙', '童話', '図書館'] } },
})

// ---------- 上限いっぱいの話題（17位） ----------

/** 文を n 字（コードポイント）にそろえる（短ければ pad をくり返して足し、長ければ切る。前後に空白を作らない） */
function fitChars(base: string, n: number, pad = '上限いっぱいの長さを確かめるための作り物の文です。'): string {
  let s = base
  while (Array.from(s).length < n) s += pad
  return Array.from(s).slice(0, n).join('')
}

/** 上限いっぱいの欄の、k 番目の文（番号が入るので、文の頭はその欄の中で1つだけ） */
const filledSentence = (label: string, k: number): string =>
  `${label}の${k}番目の文で、上限いっぱいまで字を並べて、長さを確かめるために書いた作り物の文です。`

/**
 * 上限いっぱいの欄の文（n 字）。番号つきの文を並べるので、k 番目の文の頭の40字は、その欄で最初に出る所が k 番目の文の頭になる
 * （強調の語句に使う。maxPhrases）
 */
function filledText(label: string, n: number): string {
  let s = ''
  for (let k = 1; Array.from(s).length < n; k++) s += filledSentence(label, k)
  return Array.from(s).slice(0, n).join('')
}

/** filledText の文の、頭から count 個の文の頭の phraseChars 字（文は phraseChars 字より長いので重ならない。その欄で最初に出る所） */
function maxPhrases(label: string, count: number, phraseChars: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    Array.from(filledSentence(label, i + 1))
      .slice(0, phraseChars)
      .join(''),
  )
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 17位: 国内・事件。上限いっぱいの長い文（RECORD_LIMITS の境目ちょうど）。見出し 60字・要約 300字・だから何？ 各 800字・当事者 15件・
 * 見解 各 800字・経緯 12行・用語 20語（表記 40字・別名 10件 各 40字・説明 200字）・出典 8本（題 200字・URL 2,000字）・確かめられなかった点
 * 15件 各 300字・強調 全体で60か所（各 40字・1つの欄に3つ）。社の名前は作り物の一覧だけにするので、outletNames は4社まで
 * （上限の30件にはしない）。強調の量は決まりの範囲（2割）を超えるので知らせる物が出るが、断る物は無い。
 * 用語は、版ごとに新しい語になるように版の id を入れる（どの版の束にも新しく足す語があるように。makeFakeMonth）
 */
const maxLength: Story = (c) => {
  const T = RECORD_LIMITS.topic
  const E = RECORD_LIMITS.emphasis
  const P = RECORD_LIMITS.termPack
  const label = (name: string) => `長い話題の${name}`
  const emphasis: Emphasis = {}
  const field = (key: string, name: string, n: number, phrases: number) => {
    const l = label(name)
    if (phrases > 0) emphasis[key] = maxPhrases(l, phrases, E.phraseMax)
    return filledText(l, n)
  }
  const stances: Stance[] = ['for', 'against', 'conditional', 'unknown']
  const whens = [String(c.year), c.prevYm, c.date, null]
  const longTerms: TermEntry[] = Array.from({ length: T.terms }, (_, i) => {
    const key = fitChars(`用語${pad2(i + 1)}・${c.editionId}・`, T.term)
    return {
      termId: termIdOf(key),
      key,
      term: key,
      aliases: Array.from({ length: P.aliases }, (_, j) =>
        fitChars(`別名${pad2(j + 1)}・用語${pad2(i + 1)}・${c.editionId}・`, P.alias),
      ),
      explanation: filledText(`用語${pad2(i + 1)}の説明`, P.explanation),
      asOf: null,
      rev: 1,
    }
  })
  const outlets = ['〇〇通信', '△△新聞', '□□放送', FAKE_UNLISTED_OUTLET] as const
  return {
    region: 'jp',
    genre: 'incident',
    rankReason: filledText(label('順位の理由'), T.rankReason),
    headline: fitChars(`${c.pref}の上限いっぱいの見出しの見本、`, T.headline),
    summary: field('summary', '要約', T.summary, E.perField),
    conclusion: {
      label: 'unsettled',
      note: field('conclusion.note', '結論の補足', T.conclusionNote, E.perField),
      breaking: false,
    },
    soWhat: {
      life: field('soWhat.life', '暮らし', T.soWhat, E.perField),
      system: field('soWhat.system', '仕組み', T.soWhat, E.perField),
      world: field('soWhat.world', '世界', T.soWhat, E.perField),
      whyNews: field('soWhat.whyNews', 'なぜ話題か', T.soWhat, E.perField),
    },
    stakeholders: Array.from({ length: T.stakeholders }, (_, i) => ({
      name: fitChars(`当事者${pad2(i + 1)}・${c.city}の長い名前の団体の見本、`, T.stakeholderName),
      stance: stances[i % stances.length],
      stanceNote: fitChars(`当事者${pad2(i + 1)}の立場の補足、`, T.stanceNote),
      claim: field(`stakeholders.${i}.claim`, `当事者${pad2(i + 1)}の主張`, T.claim, 2),
      reason: filledText(label(`当事者${pad2(i + 1)}の理由`), T.claimReason),
    })),
    view: opposed(
      fitChars(`${label('軸')}、`, T.axis),
      field('view.aiView', 'AI の見解', T.aiView, E.perField),
      field('view.counterView', '対立見解', T.counterView, E.perField),
      fitChars(`${label('論点')}、`, T.issue),
    ),
    timeline: Array.from({ length: T.timeline }, (_, i) => ({
      when: whens[i % whens.length],
      text: field(`timeline.${i}.text`, `経緯${pad2(i + 1)}`, T.timelineText, i < 2 ? E.perField : 0),
    })),
    terms: longTerms,
    sources: Array.from({ length: T.sources }, (_, i) => {
      const outlet = outlets[i % outlets.length]
      const head = `${FAKE_URL_PREFIX}long/${c.editionId}/${pad2(i + 1)}/`
      return {
        outlet,
        via: outlet === FAKE_UNLISTED_OUTLET ? FAKE_VIA : null,
        title: fitChars(`出典${pad2(i + 1)}の長い題の見本、`, T.sourceTitle),
        url: head + 'a'.repeat(T.url - head.length),
        publishedAt: null,
        publishedNote: fitChars(`出典${pad2(i + 1)}の掲載日時の補足、`, T.publishedNote),
      }
    }),
    unverified: Array.from({ length: T.unverified }, (_, i) =>
      filledText(label(`確かめられなかった点${pad2(i + 1)}`), T.unverifiedText),
    ),
    check: { claims: T.checkClaims, fixed: T.checkClaims, model: fitChars(`${FAKE_CHECK_MODEL}-`, T.checkModel, 'x') },
    emphasis,
  }
}

/** 版の順位の順の話題（20本: 国内10・世界10、7つのジャンルすべてと知らない値 'novel' が1本、重大印1。docs/SPEC.md の 16.3） */
const LAYOUT: readonly Story[] = [
  majorOutage,
  usBill,
  jpBill,
  bonusOutlook,
  rateHike,
  aiLaw,
  aiDesk,
  fraudArrest,
  derailment,
  volleyFinal,
  videoReview,
  animeHit,
  musicPrice,
  waterRate,
  satelliteNet,
  riverDeal,
  maxLength,
  aiSources,
  chargerRule,
  libraryBook,
]

/** 選ばなかった見出しの作り物（docs/SPEC.md の 6.5。版の notChosen） */
function notChosenOf(c: Ctx): NotChosen[] {
  const pool: NotChosen[] = [
    { headline: `${c.city}で秋の祭り、3年ぶりに山車が出る`, whyNot: '地域の行事で、多くの人に関わる話題ではなかったため' },
    { headline: `${c.pref}の動物園でレッサーパンダの赤ちゃんが生まれる`, whyNot: '話題性はあったが、知るべき順で下になったため' },
    { headline: `${c.country}で新しい高速道路が開通`, whyNot: '日本の暮らしへの影響が小さかったため' },
    { headline: '〇〇社が新しいスマホを発表', whyNot: '発表だけで、暮らしへの影響がまだ見えなかったため' },
    { headline: `${c.country2}の首都で大きなデモ`, whyNot: '読める記事が1本だけで、確かめられなかったため' },
    { headline: `${c.pref}で今年初めての雪`, whyNot: '季節の便りで、急ぎの話題ではなかったため' },
    { headline: `${c.city}の商店街に新しい市場が開く`, whyNot: '同じ日に経済の話題が多く、ジャンルの数の上限に近かったため' },
    { headline: `${c.country}のプロ野球で新しい記録`, whyNot: 'スポーツは別の話題を選んだため' },
  ]
  const n = c.rng.int(4, pool.length)
  return pool.slice(0, n)
}

// ---------- 版を組み立てる ----------

const MINUTE_MS = 60 * 1000

/** 日本時間の時差つきの日時（'YYYY-MM-DDTHH:MM+09:00'） */
function jstDateTime(ms: number): string {
  const p = jstParts(ms)
  return `${p.date}T${pad2(p.hour)}:${pad2(p.minute)}+09:00`
}

/** 回を始めた時刻（枠の時刻の 100分前。12:00版は 10:20、20:00版は 18:20） */
const runStartOf = (date: string, slot: Slot): number => slotTimeMs(date, slot) - 100 * MINUTE_MS

/** 回の id（'r'＋時刻（日本時間）＋乱数。docs/SPEC.md の 7.7 の runId） */
function runIdOf(ms: number, rng: FakeRng): string {
  const p = jstParts(ms)
  return `r${p.date.replaceAll('-', '')}${pad2(p.hour)}${pad2(p.minute)}-${rng.chars(4)}`
}

/** 前の枠の時刻（候補を集めた窓の頭） */
function prevSlotTimeOf(date: string, slot: Slot): number {
  return slot === '12' ? slotTimeMs(addDaysToDate(date, -1), '20') : slotTimeMs(date, '12')
}

interface BuildOptions extends FakeEditionOptions {
  /** 辞書の今の形（termId → 語。この版で足した語を書き足す） */
  dict: Map<string, TermEntry>
  ruling: RulingState
  /** 順位 → 差し替える話題（続報の鎖） */
  overrides?: ReadonlyMap<number, Story>
}

function buildEdition(o: BuildOptions): FakeEdition {
  const { date, slot, seed } = o
  const editionId = editionIdOf(date, slot)
  const place = fakeRng(`${seed}/place`)
  const countries = [...COUNTRIES]
  const country = countries.splice(place.int(0, countries.length - 1), 1)[0]
  const country2 = place.pick(countries)
  const runStart = runStartOf(date, slot)
  const base = {
    v: 1 as const,
    by: 'connector' as const,
    ai: 'claude' as const,
    model: FAKE_MODEL,
    runId: runIdOf(runStart, fakeRng(`${seed}/run`)),
  }
  const common = {
    editionId,
    date,
    slot,
    day: Number(date.slice(8)),
    year: Number(date.slice(0, 4)),
    prevYm: prevMonthOf(date),
    city: place.pick(CITIES),
    pref: place.pick(PREFS),
    country,
    country2,
    terms: (keys: readonly string[]) => keys.map((k) => glossaryEntry(k, o.ruling)),
  }
  // この版で足す語（辞書の今の形に無い語・rev が上がった語。docs/SPEC.md の 7.3）
  const newEntries = new Map<string, TermEntry>()
  const useTerm = (e: TermEntry): TopicTerm => {
    const had = o.dict.get(e.termId)
    if (!had || had.rev < e.rev) {
      newEntries.set(e.termId, e)
      o.dict.set(e.termId, e)
    }
    return { termId: e.termId, term: e.term, aliases: [...e.aliases], explanation: e.explanation, asOf: e.asOf }
  }
  const topics = LAYOUT.map((story, i) => {
    const rank = i + 1
    const s = o.overrides?.get(rank) ?? story
    const c: Ctx = { ...common, rng: fakeRng(`${seed}/topic-${pad2(rank)}`) }
    const d = s(c)
    const createdAt = runStart + (25 + Math.floor(i / 5) * 4) * MINUTE_MS + c.rng.int(0, 59) * 1000
    return assembleTopic(d, { ...base, createdAt }, editionId, rank, useTerm, c, runStart)
  })
  if (newEntries.size === 0 || newEntries.size > RECORD_LIMITS.termPack.entries)
    throw new Error(`作り物の版 ${editionId} の束の語の数が ${newEntries.size} です（1〜${RECORD_LIMITS.termPack.entries}）`)
  const entries = [...newEntries.values()]
  const termPack: TermPack = {
    id: termPackIdOf(editionId, entries),
    ...base,
    createdAt: runStart + 10 * MINUTE_MS,
    editionId,
    entries,
  }
  const er = fakeRng(`${seed}/edition`)
  const edition: Edition = {
    id: editionId,
    ...base,
    createdAt: slotTimeMs(date, slot) - 5 * MINUTE_MS,
    date,
    slot,
    order: topics.map((t) => t.id),
    candidateCount: er.int(150, 420),
    notChosen: notChosenOf({ ...common, rng: er }),
    window: { since: jstDateTime(prevSlotTimeOf(date, slot)), until: jstDateTime(runStart) },
    usage: er.next() < 0.25 ? null : { tokens: er.int(300, 650) * 1000, toolCalls: er.int(60, 140), minutes: er.int(50, 95) },
  }
  const scenes = Object.fromEntries(
    Object.entries(FAKE_TOPIC_SCENES).map(([scene, rank]) => [scene, topics[rank - 1].id]),
  ) as Record<FakeTopicScene, string>
  return { edition, topics, termPack, scenes }
}

/** 下書きから話題の記録を組み立てる（URL・用語の写し・id・threadId。docs/SPEC.md の 7.1・7.7） */
function assembleTopic(
  d: TopicDraft,
  base: Pick<Topic, 'v' | 'by' | 'ai' | 'model' | 'runId' | 'createdAt'>,
  editionId: string,
  rank: number,
  useTerm: (e: TermEntry) => TopicTerm,
  c: Ctx,
  runStart: number,
): Topic {
  const latest = jstParts(runStart - 30 * MINUTE_MS).hour
  const sources: Source[] = d.sources.map((s, i) => {
    const via = s.via ?? null
    const hour = c.rng.int(Math.max(0, latest - 4), latest)
    return {
      ...s.extra,
      outlet: s.outlet,
      title: s.title,
      url: s.url ?? `${FAKE_URL_PREFIX}${via ? 'via' : 'news'}/${editionId}/${pad2(rank)}-${i + 1}`,
      publishedAt: s.publishedAt !== undefined ? s.publishedAt : `${c.date}T${pad2(hour)}:${pad2(c.rng.int(0, 59))}+09:00`,
      publishedNote: s.publishedNote ?? null,
      via,
    }
  })
  const outletNames = [...new Set([...sources.map((s) => s.outlet), ...(d.moreOutlets ?? [])])]
  const t = {
    ...d.extra,
    id: '',
    ...base,
    editionId,
    threadId: '',
    rank,
    rankReason: d.rankReason,
    region: d.region as Region,
    genre: d.genre as Genre,
    major: d.major ?? false,
    headline: d.headline,
    summary: d.summary,
    conclusion: d.conclusion,
    soWhat: d.soWhat,
    stakeholders: (d.stakeholders ?? []) as Stakeholder[],
    view: d.view,
    timeline: d.timeline,
    followUp: d.followUp ?? null,
    terms: d.terms.map(useTerm),
    sources,
    outletNames,
    unverified: d.unverified ?? [],
    check: d.check !== undefined ? d.check : { claims: c.rng.int(15, 45), fixed: c.rng.int(0, 3), model: FAKE_CHECK_MODEL },
    emphasis: d.emphasis,
  } satisfies Topic
  // threadId は指紋に入らないので、id を作った後に付ける（docs/SPEC.md の 7.7 の「名札」）
  t.id = topicIdOf(t)
  t.threadId = d.threadId ?? t.id
  return t
}

// ---------- 何日分かの版（続報の鎖・作れなかった枠・時期で変わる語・訂正） ----------

export interface FakeMonthOptions {
  /** いちばん新しい版の日付（'YYYY-MM-DD'。日本時間。ふつうは今日） */
  until: string
  /** 何日分か（3以上。31以上なら、いちばん古い日の版は until から見て30日の境の外） */
  days: number
  /** 乱数の種（省くと 'fake-month'） */
  seed?: string
  /** until の日の最後の枠（省くと '20'。'12' なら until の 20:00版を作らない） */
  untilSlot?: Slot
}

export interface FakeMonthScenes {
  /** 続報の鎖（「〇〇市で新しい橋が開通」→「…開通後の渋滞が2割減」→「…点検で1日通行止め」）の話題の id */
  chain: [string, string, string]
  /** 作れなかった枠の版の id（版の記録は無く、作れなかった印だけがある。reasonKind: 'quota'） */
  failedEditionId: string
  /** 訂正を付けた話題の id */
  corrections: {
    /** 続報の鎖の1本目（「新しい橋の歩道の幅は 2メートルではなく 3メートルでした」） */
    chainFirst: string
    /** 訂正が2つある話題（2つ目は1つ目の訂正の誤りを正す） */
    twice: string
    /** いちばん古い版の話題（days が31以上なら、until から見て30日の境の外） */
    oldest: string
  }
  /** 時期で変わる語（「与党（日本）」）。changedIn の版から rev 2 になり、asOf が上がる */
  changingTerm: { key: string; termId: string; asOfBefore: string; asOfAfter: string; changedIn: string }
}

export interface FakeMonth {
  /** 作れた版（古い順） */
  editions: FakeEdition[]
  /** 作れなかった印 */
  editionFails: EditionFail[]
  /** 訂正（作った順） */
  corrections: CorrectionRecord[]
  scenes: FakeMonthScenes
}

/** 続報の鎖の1本目の訂正の文（docs/SPEC.md の 7.1 の「訂正」・16.3 の例） */
export const CHAIN_CORRECTION_TEXT = '新しい橋の歩道の幅は 2メートルではなく 3メートルでした'

/** 続報の鎖の話題の、前の話題（2本目・3本目） */
interface ChainLink {
  id: string
  threadId: string
  date: string
}

/** 続報の鎖の1本目「〇〇市で新しい橋が開通」（docs/SPEC.md の 5.12 の例・7.8 の「続報のつなぎ」の例） */
const bridgeOpens: Story = (c) => ({
  region: 'jp',
  genre: 'economy',
  rankReason: '市の中心部と東部を結ぶ道の節目で、暮らしへの影響が大きいため',
  headline: '〇〇市で新しい橋が開通、市は朝夕の渋滞が2割ほど減る見通しを示す',
  summary: `〇〇市が建設を進めてきた新しい橋が${c.day}日に開通し、市の中心部と東部の住宅地が1本の道で結ばれた。長さは320メートルで、歩道の幅は2メートル。市は朝夕の渋滞が2割ほど減る見通しを示した。通行料はまだ決まっていない。市は来年3月までに決めるとしている。`,
  conclusion: { label: 'outlook', note: '開通は確定、渋滞が減るかは市の見通しの段階', breaking: false },
  soWhat: {
    life: '朝夕に車で中心部へ通う人は、通勤の時間が短くなる見込みです。',
    system: '橋の通行料は市が案を作り、市議会の議決で決まります。',
    world: null,
    whyNews: '中心部と東部を結ぶ道は、長く渋滞が課題でした。',
  },
  stakeholders: [
    {
      name: 'A 党',
      stance: 'for',
      stanceNote: null,
      claim: '通行料は無料にすべきだと主張している。',
      reason: '市民の負担を減らすため。',
    },
    {
      name: 'B 党',
      stance: 'conditional',
      stanceNote: '料金の額しだい',
      claim: '維持費のために少額の通行料を取るべきだと主張している。',
      reason: '修繕の費用をまかなうため。',
    },
    { name: 'C 党', stance: 'unknown', stanceNote: null, claim: null, reason: null },
  ],
  view: opposed(
    '成長・企業重視 ⇔ 分配・生活者重視',
    '開通で中心部の商店に人が戻る効果は、大きいように見えます。',
    '渋滞が東部の住宅地へ移るだけになるおそれも、あると考えます。',
  ),
  timeline: [
    { when: '2023-04', text: '新しい橋の建設が始まった' },
    { when: c.date, text: '新しい橋が開通した' },
    { when: null, text: 'その後、市が通行料の案を示す予定' },
  ],
  terms: c.terms(['通行料', '市議会', '渋滞', '歩道', '住宅地', '中心部', '維持費', '修繕', '議決', '予算', '開通', '交通量']),
  sources: [
    { outlet: '〇〇通信', title: '〇〇市の新しい橋が開通' },
    { outlet: FAKE_UNLISTED_OUTLET, via: FAKE_VIA, title: '新しい橋が開通 渋滞2割減の見通し', publishedAt: c.date },
  ],
  moreOutlets: ['△△新聞'],
  unverified: ['通行料の案の中身は確かめられなかった'],
  emphasis: {
    summary: [`${c.day}日に開通`, '通行料はまだ決まっていない'],
    'soWhat.life': ['時間が短くなる見込み'],
    'stakeholders.0.claim': ['通行料は無料にすべき'],
    'stakeholders.1.claim': ['少額の通行料を取るべき'],
    'view.aiView': ['人が戻る効果は、大きい'],
    'view.counterView': ['住宅地へ移るだけ'],
    'timeline.1.text': ['新しい橋が開通した'],
  },
})

/** 続報の鎖の2本目「〇〇市の新しい橋、開通後の渋滞が2割減」 */
const bridgeTraffic =
  (prev: ChainLink): Story =>
  (c) => ({
    region: 'jp',
    genre: 'economy',
    rankReason: '前に伝えた新しい橋の効果が、数字で分かったため',
    headline: '〇〇市の新しい橋、開通後の渋滞が2割減と市が発表、東部の住宅地でも効果',
    summary: `〇〇市は${c.day}日、新しい橋が開通してからの交通量の調べをまとめ、朝夕の中心部の渋滞が2割ほど減ったと発表した。開通の前に示していた見通しのとおりだという。一方で、東部の住宅地の中の細い道では、抜け道として通る車が増えた所もある。市は、通行料の案を来月の市議会に出すとしている。`,
    conclusion: settled('渋滞が2割ほど減ったことは確定、抜け道の対策はこれから'),
    soWhat: {
      life: '朝夕に車で中心部へ通う人は、前より早く着けるようになっています。住宅地の細い道では、車に気をつける必要があります。',
      system: '通行料の案は来月の市議会に出され、議決で決まります。',
      world: null,
      whyNews: '開通の前の見通しが当たったかに、市民の関心が集まっていたためです。',
    },
    view: opposed(
      '成長・企業重視 ⇔ 分配・生活者重視',
      '渋滞が見通しのとおり減ったことは、橋を作った効果が出ている印に見えます。',
      '住宅地の細い道に車が増えたのなら、住む人の安全に目を向けるべきだと考えます。',
    ),
    timeline: [
      { when: prev.date, text: '新しい橋が開通した' },
      { when: c.date, text: '開通後の渋滞が2割ほど減ったと市が発表した' },
    ],
    followUp: { prevTopicId: prev.id, whatsNew: '市が開通後の交通量の調べを発表した' },
    terms: c.terms([
      '渋滞',
      '交通量',
      '開通',
      '通行料',
      '中心部',
      '住宅地',
      '市議会',
      '調査',
      '発表',
      '見通し',
      '抜け道',
      '議決',
    ]),
    sources: [
      { outlet: '〇〇通信', title: '〇〇市の新しい橋、渋滞が2割減' },
      { outlet: '△△新聞', title: '新しい橋の効果 住宅地の抜け道に車も' },
    ],
    unverified: [],
    emphasis: {
      summary: ['渋滞が2割ほど減った', '抜け道として通る車が増えた'],
      'view.aiView': ['効果が出ている印'],
      'view.counterView': ['住む人の安全'],
      'timeline.1.text': ['2割ほど減った'],
      'followUp.whatsNew': ['交通量の調べを発表'],
    },
    threadId: prev.threadId,
  })

/** 続報の鎖の3本目「〇〇市の新しい橋、点検で1日通行止め」 */
const bridgeClosure =
  (prev: ChainLink, first: ChainLink): Story =>
  (c) => ({
    region: 'jp',
    genre: 'economy',
    rankReason: '前に伝えた新しい橋を通る人の予定にかかわるため',
    headline: '〇〇市の新しい橋、点検で1日通行止め、市は来週の土曜に行うと発表',
    summary: `〇〇市は${c.day}日、新しい橋の点検のため、来週の土曜に1日通行止めにすると発表した。開通の後に初めて行う決まった点検で、橋に悪い所が見つかったわけではないという。通行止めの間は、前からある古い橋へ迂回するよう呼びかけている。市は、当日は中心部で渋滞が起きやすくなる見通しを示した。`,
    conclusion: { label: 'outlook', note: '通行止めの日は確定、渋滞が起きるかは見通しの段階', breaking: false },
    soWhat: {
      life: '来週の土曜に車で中心部へ行く人は、古い橋へ迂回するか、時間をずらすと渋滞をさけやすくなります。',
      system: '橋は、決まった間を空けて点検する決まりがあり、市が行います。',
      world: null,
      whyNews: '開通して間もない橋の通行止めで、使う人の予定にかかわるためです。',
    },
    view: { kind: 'none', noneReason: null },
    timeline: [
      { when: first.date, text: '新しい橋が開通した' },
      { when: prev.date, text: '開通後の渋滞が2割ほど減ったと市が発表した' },
      { when: c.date, text: '点検のための通行止めを市が発表した' },
    ],
    followUp: { prevTopicId: prev.id, whatsNew: '市が点検のための1日の通行止めを発表した' },
    terms: c.terms(['点検', '通行止め', '開通', '迂回', '渋滞', '交通量', '修繕', '維持費', '発表', '通行料', '中心部']),
    sources: [
      { outlet: '□□放送', title: '〇〇市の新しい橋、点検で1日通行止め' },
      { outlet: '〇〇通信', title: '新しい橋の点検 古い橋へ迂回を' },
    ],
    unverified: [],
    emphasis: {
      summary: ['来週の土曜に1日通行止め', '悪い所が見つかったわけではない'],
      'soWhat.life': ['古い橋へ迂回する'],
      'timeline.2.text': ['通行止めを市が発表'],
      'followUp.whatsNew': ['1日の通行止め'],
    },
    threadId: prev.threadId,
  })

/** 何日分かの作り物の版（古い順） */
export function makeFakeMonth(opts: FakeMonthOptions): FakeMonth {
  const { until, days, seed = 'fake-month', untilSlot = '20' } = opts
  if (!isYmd(until)) throw new RangeError(`until は 'YYYY-MM-DD' にしてください（${until}）`)
  if (!Number.isInteger(days) || days < 3) throw new RangeError(`days は3以上の整数にしてください（${days}）`)
  const slots: { date: string; slot: Slot }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = addDaysToDate(until, -i)
    for (const slot of SLOT_VALUES) if (!(i === 0 && slot === '20' && untilSlot === '12')) slots.push({ date, slot })
  }
  const failedEditionId = editionIdOf(addDaysToDate(until, -1), '12')
  const chainAt = [
    editionIdOf(addDaysToDate(until, -2), '12'),
    editionIdOf(addDaysToDate(until, -1), '20'),
    editionIdOf(until, '12'),
  ] as const
  // 時期で変わる語: 真ん中の枠（作れなかった枠なら次の枠）から rev 2 になり、asOf が上がる
  let changeIndex = Math.floor(slots.length / 2)
  if (editionIdOf(slots[changeIndex].date, slots[changeIndex].slot) === failedEditionId) changeIndex += 1
  const changeDate = slots[changeIndex].date
  const asOfAfter = changeDate.slice(0, 7)
  const asOfBefore = prevMonthOf(changeDate)
  const dict = new Map<string, TermEntry>()
  const editions: FakeEdition[] = []
  const editionFails: EditionFail[] = []
  const chain: ChainLink[] = []
  slots.forEach(({ date, slot }, i) => {
    const editionId = editionIdOf(date, slot)
    const edSeed = `${seed}/${editionId}`
    if (editionId === failedEditionId) {
      // 作れなかった枠（使用量の上限。版の記録の代わりに印を足す。docs/SPEC.md の 4.7・7.2）
      const runStart = runStartOf(date, slot)
      const runId = runIdOf(runStart, fakeRng(`${edSeed}/run`))
      const fail = {
        editionId,
        runId,
        reasonKind: 'quota' as const,
        reason: '使用量の上限に届いたため、この回は版を作れませんでした',
      }
      editionFails.push({
        id: editionFailIdOf(fail),
        v: 1,
        createdAt: slotTimeMs(date, slot) - 2 * MINUTE_MS,
        by: 'connector',
        ai: 'claude',
        model: FAKE_MODEL,
        ...fail,
      })
      return
    }
    const ruling: RulingState = {
      jp:
        i < changeIndex
          ? { rev: 1, asOf: asOfBefore, explanation: RULING_JP_EXPLANATIONS[0] }
          : { rev: 2, asOf: asOfAfter, explanation: RULING_JP_EXPLANATIONS[1] },
      usAsOf: asOfBefore,
    }
    const overrides = new Map<number, Story>()
    const link = chainAt.indexOf(editionId as (typeof chainAt)[number])
    if (link === 0) overrides.set(CHAIN_RANK, bridgeOpens)
    else if (link === 1) overrides.set(CHAIN_RANK, bridgeTraffic(chain[0]))
    else if (link === 2) overrides.set(CHAIN_RANK, bridgeClosure(chain[1], chain[0]))
    const ed = buildEdition({ date, slot, seed: edSeed, dict, ruling, overrides })
    if (link >= 0) {
      const t = ed.topics[CHAIN_RANK - 1]
      chain.push({ id: t.id, threadId: t.threadId, date })
    }
    editions.push(ed)
  })
  const byId = new Map(editions.map((e) => [e.edition.id, e]))
  const editionAt = (editionId: string): FakeEdition => {
    const ed = byId.get(editionId)
    if (!ed) throw new Error(`作り物の版 ${editionId} がありません`)
    return ed
  }
  // 訂正（docs/SPEC.md の 7.1 の「訂正」・7.8 の「訂正を足す・出す」）: 鎖の1本目に1つ（2本目の定期実行の回の中で、版の記録より前に足す）・
  // 1つの話題に2つ（いちばん新しい版の話題。どちらも訂正だけの回で足し、2つ目は1つ目の誤りを正す。訂正は直さず、もう1つ足して正す）・
  // いちばん古い版の話題に1つ（その日の訂正だけの回。days が31以上なら、until から見て30日の境の外で、話題と一緒に消える物）。
  // 足すのは、どれも版の記録がある版の話題（アプリに出た話題）だけ
  const newest = editions[editions.length - 1]
  const oldest = editions[0]
  const twice = newest.topics[FAKE_TOPIC_SCENES.soWhatLifeNull - 1]
  const old = oldest.topics[FAKE_TOPIC_SCENES.noCheck - 1]
  const chainFirst = editionAt(chainAt[0]).topics[CHAIN_RANK - 1]
  const chainSecondEdition = editionAt(chainAt[1]).edition
  const cr = fakeRng(`${seed}/corrections`)
  const correctionRun = (ms: number) => runIdOf(ms, cr)
  const correction = (topic: Topic, text: string, createdAt: number, runId: string): CorrectionRecord => ({
    id: correctionIdOf({ topicId: topic.id, text }),
    v: 1,
    createdAt,
    by: 'connector',
    ai: 'claude',
    model: FAKE_MODEL,
    runId,
    topicId: topic.id,
    editionId: topic.editionId,
    text,
  })
  const firstAt = newest.edition.createdAt + 40 * MINUTE_MS
  const secondAt = newest.edition.createdAt + 90 * MINUTE_MS
  const oldAt = oldest.edition.createdAt + 6 * 60 * MINUTE_MS
  const day = Number(twice.editionId.slice(8, 10))
  const dayBefore = Number(addDaysToDate(twice.editionId.slice(0, 10), -1).slice(8))
  const corrections = [
    correction(old, '脱線したのは国の東部ではなく、北部の区間でした', oldAt, correctionRun(oldAt)),
    correction(chainFirst, CHAIN_CORRECTION_TEXT, chainSecondEdition.createdAt - 30 * MINUTE_MS, chainSecondEdition.runId),
    correction(twice, `中央銀行が利上げを決めた日は ${day}日ではなく ${dayBefore}日でした`, firstAt, correctionRun(firstAt)),
    correction(
      twice,
      `先の訂正は誤りで、中央銀行が利上げを決めた日は ${day}日で合っていました`,
      secondAt,
      correctionRun(secondAt),
    ),
  ].sort((a, b) => a.createdAt - b.createdAt)
  const changedIn = editionIdOf(slots[changeIndex].date, slots[changeIndex].slot)
  return {
    editions,
    editionFails,
    corrections,
    scenes: {
      chain: [chain[0].id, chain[1].id, chain[2].id],
      failedEditionId,
      corrections: { chainFirst: chainFirst.id, twice: twice.id, oldest: old.id },
      changingTerm: { key: RULING_JP_KEY, termId: termIdOf(RULING_JP_KEY), asOfBefore, asOfAfter, changedIn },
    },
  }
}

/** 続報の鎖の話題を置く順位（国内・経済の14位） */
const CHAIN_RANK = 14

// ---------- 記録をコネクタが足す順に並べる ----------

/** 作り物の記録1件（表の名前と記録） */
export type FakeRecord = { [T in ConnectorTableName]: { table: T; record: TableRecords[T] } }[ConnectorTableName]

const TABLE_ORDER: Readonly<Record<ConnectorTableName, number>> = {
  termPacks: 0,
  topics: 1,
  editions: 2,
  editionFails: 3,
  corrections: 4,
}

/**
 * 記録を、コネクタが足す順（作った時刻の順。同じ時刻なら辞書の束 → 話題 → 版。docs/SPEC.md の 7.8 の「コネクタの足す順」）に並べる。
 * エミュレーターに入れる道具・偽のクラウドが、updated の順に書くのに使う
 */
export function fakeRecordsOf(src: FakeEdition | FakeMonth): FakeRecord[] {
  const eds = 'editions' in src ? src.editions : [src]
  const out: FakeRecord[] = []
  for (const e of eds) {
    out.push({ table: 'termPacks', record: e.termPack })
    for (const t of e.topics) out.push({ table: 'topics', record: t })
    out.push({ table: 'editions', record: e.edition })
  }
  if ('editions' in src) {
    for (const f of src.editionFails) out.push({ table: 'editionFails', record: f })
    for (const c of src.corrections) out.push({ table: 'corrections', record: c })
  }
  return out.sort((a, b) => a.record.createdAt - b.record.createdAt || TABLE_ORDER[a.table] - TABLE_ORDER[b.table])
}
