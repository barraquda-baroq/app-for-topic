// このファイルは npm --prefix connector run gen-schemas（scripts/gen-schemas.mjs）が src/mcp/schemas.ts から作る。手で直さない。
// zod の定義を JSON Schema（{ io: 'input' }）にしたもの。Workers の中で zod から作り直さないように、作った結果を置いておく。

export type ToolName =
  | 'topic_status'
  | 'topic_get_guide'
  | 'topic_list_candidates'
  | 'topic_read_article'
  | 'topic_list_recent'
  | 'topic_lookup_terms'
  | 'topic_find_topics'
  | 'topic_list_drafts'
  | 'topic_get_draft'
  | 'topic_begin_run'
  | 'topic_save_draft'
  | 'topic_check_draft'
  | 'topic_add_topics'
  | 'topic_add_edition'
  | 'topic_add_edition_fail'
  | 'topic_add_correction'

export const TOOL_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  "topic_status": {
    "type": "object",
    "properties": {
      "runId": {
        "description": "版の回・試しの回の id（渡すと、その回の候補集めが終わったかと読める候補の数。試しの回は probe の表も）",
        "type": "string",
        "minLength": 1,
        "maxLength": 60
      }
    }
  },
  "topic_get_guide": {
    "type": "object",
    "properties": {
      "role": {
        "type": "string",
        "enum": [
          "select",
          "write",
          "verify",
          "correct"
        ],
        "description": "係（select 選ぶ・write 書く・verify 照合・correct 訂正）"
      }
    },
    "required": [
      "role"
    ]
  },
  "topic_list_candidates": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40,
        "description": "前の答えの最後にある「続きがあります（cursor: …）」の値をそのまま渡す"
      }
    },
    "required": [
      "runId"
    ]
  },
  "topic_read_article": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000,
        "description": "読む資料（候補の c0012 か、許した出どころの https:// の URL。前の版の出典など）"
      },
      "maxChars": {
        "default": 6000,
        "description": "1回に返す本文の字数（1,500〜6,000。既定 6,000）",
        "type": "integer",
        "minimum": 1500,
        "maximum": 6000
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40,
        "description": "前の答えの最後にある「続きがあります（cursor: …）」の値をそのまま渡す"
      }
    },
    "required": [
      "runId",
      "ref"
    ]
  },
  "topic_list_recent": {
    "type": "object",
    "properties": {}
  },
  "topic_lookup_terms": {
    "type": "object",
    "properties": {
      "words": {
        "minItems": 1,
        "maxItems": 40,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "description": "引く語（1〜40語。各 40字まで）"
      },
      "runId": {
        "description": "渡すと、同じ回のほかの下書きで足す語も返す",
        "type": "string",
        "minLength": 1,
        "maxLength": 60
      }
    },
    "required": [
      "words"
    ]
  },
  "topic_find_topics": {
    "type": "object",
    "properties": {
      "edition": {
        "description": "版（e:2026-11-15-12 の形か版の id）",
        "type": "string",
        "minLength": 1,
        "maxLength": 20
      },
      "date": {
        "description": "版の日付（YYYY-MM-DD。日本時間）",
        "type": "string",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
      },
      "slot": {
        "description": "版の枠（12 か 20）",
        "type": "string",
        "enum": [
          "12",
          "20"
        ]
      },
      "words": {
        "description": "見出し・要約に含む語（5語まで）",
        "minItems": 1,
        "maxItems": 5,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        }
      }
    }
  },
  "topic_list_drafts": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      }
    },
    "required": [
      "runId"
    ]
  },
  "topic_get_draft": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "draft": {
        "type": "string",
        "minLength": 1,
        "maxLength": 20,
        "description": "下書きの id（d:01 の形。topic_save_draft の答え・topic_list_drafts で分かる）"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40,
        "description": "前の答えの最後にある「続きがあります（cursor: …）」の値をそのまま渡す"
      }
    },
    "required": [
      "runId",
      "draft"
    ]
  },
  "topic_begin_run": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "edition",
          "trial",
          "correction"
        ],
        "description": "回の種類（edition 版の回＝定期実行の依頼だけ・trial 試しの回＝クラウドに書かない・correction 訂正だけの回）"
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "使っているモデルの名前（60字まで。記録の model に入る）"
      },
      "probe": {
        "description": "試しの回だけ（sources 出どころごとの数・hosts 今は取らない府省の robots.txt の番号・terms 規約のページ）",
        "type": "string",
        "enum": [
          "sources",
          "hosts",
          "terms"
        ]
      },
      "skip": {
        "description": "試しの回だけ。probe から外す出どころの id",
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        }
      }
    },
    "required": [
      "kind",
      "model"
    ]
  },
  "topic_save_draft": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "使っているモデルの名前（60字まで。記録の model に入る）"
      },
      "replace": {
        "description": "照合の前の下書きを置き換える時、その下書きの id",
        "type": "string",
        "minLength": 1,
        "maxLength": 20
      },
      "topic": {
        "type": "object",
        "properties": {
          "rank": {
            "type": "integer",
            "minimum": 1,
            "maximum": 30,
            "description": "版の中の順位（1〜30）"
          },
          "rankReason": {
            "type": "string",
            "description": "順位の理由（200字まで）"
          },
          "region": {
            "type": "string",
            "enum": [
              "jp",
              "world"
            ],
            "description": "地域（jp 国内・world 世界）"
          },
          "genre": {
            "type": "string",
            "enum": [
              "politics",
              "economy",
              "tech",
              "ai",
              "incident",
              "sports",
              "entertainment"
            ],
            "description": "ジャンル（politics・economy・tech・ai・incident・sports・entertainment）"
          },
          "major": {
            "type": "boolean",
            "description": "重大印"
          },
          "headline": {
            "type": "string",
            "description": "見出し（60字まで）"
          },
          "summary": {
            "type": "string",
            "description": "要約（300字まで）"
          },
          "conclusion": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string",
                "enum": [
                  "settled",
                  "unsettled",
                  "outlook"
                ],
                "description": "結論ラベル（settled 確定・unsettled 未確定・outlook 見通し）"
              },
              "note": {
                "type": "string",
                "description": "結論の補足（200字まで）"
              },
              "breaking": {
                "type": "boolean",
                "description": "速報・未確認の印（発表が自分で「第1報」「速報」と書いている時だけ）"
              }
            },
            "required": [
              "label",
              "note",
              "breaking"
            ]
          },
          "soWhat": {
            "type": "object",
            "properties": {
              "life": {
                "description": "暮らし・お金（800字まで。null = この話題では特になし）",
                "type": [
                  "string",
                  "null"
                ]
              },
              "system": {
                "description": "社会の仕組み（800字まで。null = この話題では特になし）",
                "type": [
                  "string",
                  "null"
                ]
              },
              "world": {
                "description": "世界の力関係（800字まで。null = この話題では特になし）",
                "type": [
                  "string",
                  "null"
                ]
              },
              "whyNews": {
                "description": "なぜ話題か（800字まで。null = この話題では特になし）",
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "life",
              "system",
              "world",
              "whyNews"
            ]
          },
          "stakeholders": {
            "maxItems": 15,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string",
                  "description": "当事者の名前（60字まで）"
                },
                "stance": {
                  "type": "string",
                  "enum": [
                    "for",
                    "against",
                    "conditional",
                    "unknown"
                  ],
                  "description": "立場（for 賛成・against 反対・conditional 条件付き・unknown 不明）"
                },
                "stanceNote": {
                  "description": "立場の補足（60字まで。null = なし）",
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "claim": {
                  "description": "主張（400字まで。null = 今回読んだ資料では、主張を確かめられなかった（その時 stance は unknown・stanceNote と reason は null））",
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "reason": {
                  "description": "主張の理由（300字まで。null = なし（claim が null なら null））",
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "claimEmphasis": {
                  "maxItems": 3,
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "主張の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
                }
              },
              "required": [
                "name",
                "stance",
                "stanceNote",
                "claim",
                "reason"
              ]
            },
            "description": "当事者（15件まで。並びに意味がある）"
          },
          "view": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "opposed",
                    "description": "AI の見解と対立見解がある"
                  },
                  "axis": {
                    "type": "string",
                    "description": "対立の軸（80字まで）"
                  },
                  "issue": {
                    "description": "論点（150字まで。null = なし）",
                    "type": [
                      "string",
                      "null"
                    ]
                  },
                  "aiView": {
                    "type": "string",
                    "description": "AI の見解（800字まで）"
                  },
                  "counterView": {
                    "type": "string",
                    "description": "対立見解（800字まで）"
                  }
                },
                "required": [
                  "kind",
                  "axis",
                  "issue",
                  "aiView",
                  "counterView"
                ]
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "none",
                    "description": "対立する見解は無い"
                  },
                  "noneReason": {
                    "description": "対立する見解が無い訳（200字まで。null = 事実の報道のため）",
                    "type": [
                      "string",
                      "null"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "noneReason"
                ]
              }
            ]
          },
          "timeline": {
            "maxItems": 12,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "when": {
                  "description": "YYYY・YYYY-MM・YYYY-MM-DD（資料に書かれた日付のまま。null = 日付が分からない）",
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "text": {
                  "type": "string",
                  "description": "経緯の1行（160字まで）"
                },
                "emphasis": {
                  "maxItems": 3,
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "この行の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
                }
              },
              "required": [
                "when",
                "text"
              ]
            },
            "description": "経緯（12行まで。書いた順）"
          },
          "followUp": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "prev": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 20,
                    "description": "前の版の話題の短い id（p:＋8字。topic_list_recent の一覧の中の物）"
                  },
                  "whatsNew": {
                    "type": "string",
                    "description": "前の話題から新しくなった事（200字まで）"
                  }
                },
                "required": [
                  "prev",
                  "whatsNew"
                ]
              },
              {
                "type": "null"
              }
            ],
            "description": "続報の時だけ（null = 続報でない）"
          },
          "terms": {
            "maxItems": 40,
            "type": "array",
            "items": {
              "anyOf": [
                {
                  "type": "object",
                  "properties": {
                    "termId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 20,
                      "description": "辞書の語の id（t＋12字）"
                    },
                    "revise": {
                      "type": "object",
                      "properties": {
                        "explanation": {
                          "type": "string",
                          "description": "新しい説明（200字まで）"
                        },
                        "asOf": {
                          "description": "説明の時点（YYYY-MM。null = 不明）",
                          "type": [
                            "string",
                            "null"
                          ]
                        },
                        "aliases": {
                          "description": "別名を替える時だけ",
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "string"
                          }
                        }
                      },
                      "required": [
                        "explanation",
                        "asOf"
                      ],
                      "additionalProperties": false,
                      "description": "辞書の説明を新しくする（rev はコネクタが今の rev ＋1 にする）"
                    }
                  },
                  "required": [
                    "termId",
                    "revise"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "new": {
                      "type": "object",
                      "properties": {
                        "key": {
                          "type": "string",
                          "description": "照らすための形（国などで中身の違う語は括弧の添え字を付ける。例「与党（日本）」）（60字まで）"
                        },
                        "term": {
                          "type": "string",
                          "description": "見出しの表記（40字まで）"
                        },
                        "aliases": {
                          "maxItems": 10,
                          "type": "array",
                          "items": {
                            "type": "string"
                          },
                          "description": "別名（10件まで・各 40字まで）"
                        },
                        "explanation": {
                          "type": "string",
                          "description": "説明（200字まで）"
                        },
                        "asOf": {
                          "description": "説明の時点（YYYY-MM。null = 不明）",
                          "type": [
                            "string",
                            "null"
                          ]
                        }
                      },
                      "required": [
                        "key",
                        "term",
                        "aliases",
                        "explanation",
                        "asOf"
                      ],
                      "additionalProperties": false,
                      "description": "辞書に無い語（話題を足す最初の呼び出しで、辞書の束にして先に足す）"
                    }
                  },
                  "required": [
                    "new"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "termId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 20,
                      "description": "辞書の語の id（t＋12字。topic_lookup_terms で引いた物）"
                    },
                    "term": {
                      "description": "この話題での表記（辞書の表記か別名。省くと辞書の表記）",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 40
                    }
                  },
                  "required": [
                    "termId"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "term": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 40,
                      "description": "辞書にある語を表記で指す（2つ以上の語に当たれば断るので termId で指す）"
                    }
                  },
                  "required": [
                    "term"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "description": "用語（話題に入るのは20語まで。「いまの説明で知ってる」語はコネクタが外す）"
          },
          "sources": {
            "minItems": 1,
            "maxItems": 8,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "ref": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 2000,
                  "description": "出典にする資料（候補の c0012 か、この回で topic_read_article が読んだ資料の URL）"
                },
                "outlet": {
                  "description": "1つのホストに社が2つ以上ある時だけ、どの社か（topic_read_article の頭の行に並ぶ社）",
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 40
                }
              },
              "required": [
                "ref"
              ]
            },
            "description": "出典（1〜8本。url・題・日時・社・著者はコネクタが資料の控えから書く）"
          },
          "unverified": {
            "maxItems": 15,
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "確かめられなかった点（15件まで・各 300字まで）"
          },
          "emphasis": {
            "type": "object",
            "properties": {
              "summary": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 summary の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "conclusion.note": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 conclusion.note の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "soWhat.life": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 soWhat.life の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "soWhat.system": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 soWhat.system の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "soWhat.world": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 soWhat.world の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "soWhat.whyNews": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 soWhat.whyNews の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "view.aiView": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 view.aiView の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "view.counterView": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 view.counterView の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              },
              "followUp.whatsNew": {
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "欄 followUp.whatsNew の強調の語句（その欄の文に1字も違わずに含まれる 2〜40字。1つの欄に3つまで・話題の全体で60まで）"
              }
            },
            "description": "欄ごとの強調の語句（当事者の主張は claimEmphasis、経緯の行は emphasis に書く）"
          }
        },
        "required": [
          "rank",
          "rankReason",
          "region",
          "genre",
          "major",
          "headline",
          "summary",
          "conclusion",
          "soWhat",
          "stakeholders",
          "view",
          "timeline",
          "followUp",
          "terms",
          "sources",
          "unverified"
        ],
        "description": "話題の下書き（欄の名前は記録と同じ）"
      }
    },
    "required": [
      "runId",
      "model",
      "topic"
    ]
  },
  "topic_check_draft": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "draft": {
        "type": "string",
        "minLength": 1,
        "maxLength": 20,
        "description": "下書きの id（d:01 の形。topic_save_draft の答え・topic_list_drafts で分かる）"
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "使っているモデルの名前（60字まで。記録の model に入る）"
      },
      "claims": {
        "type": "integer",
        "minimum": 0,
        "maximum": 500,
        "description": "照合した主張の件数（0〜500）"
      },
      "patches": {
        "maxItems": 60,
        "type": "array",
        "items": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 80,
                  "description": "入力の欄の道（. でつなぎ、並びは 0 から。例 summary・stakeholders.1.claim・timeline.3・terms.5.explanation）"
                },
                "find": {
                  "type": "string",
                  "minLength": 1,
                  "description": "置き換える文の一部（その欄に1回だけ出る文）"
                },
                "to": {
                  "type": "string",
                  "description": "置き換えた後の文"
                },
                "why": {
                  "type": "string",
                  "enum": [
                    "name",
                    "date",
                    "number",
                    "quote",
                    "reason",
                    "overstate",
                    "notInSource",
                    "rule",
                    "term",
                    "subject",
                    "area",
                    "other"
                  ],
                  "description": "直した訳（name 固有名・date 日付・number 数字・quote 引用・reason 理由・overstate 言い過ぎ・notInSource 資料に無い・rule 決まり・term 用語・subject 主体・area 区域や対象・other）"
                }
              },
              "required": [
                "path",
                "find",
                "to",
                "why"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 80,
                  "description": "入力の欄の道（. でつなぎ、並びは 0 から。例 summary・stakeholders.1.claim・timeline.3・terms.5.explanation）"
                },
                "set": {
                  "anyOf": [
                    {
                      "type": "string"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "boolean"
                    },
                    {
                      "type": "null"
                    },
                    {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  ],
                  "description": "決まった値・null にする（例 conclusion.label・soWhat.life・stakeholders.1.claim。丸ごと替えられる並びは unverified と別名だけ）"
                },
                "why": {
                  "type": "string",
                  "enum": [
                    "name",
                    "date",
                    "number",
                    "quote",
                    "reason",
                    "overstate",
                    "notInSource",
                    "rule",
                    "term",
                    "subject",
                    "area",
                    "other"
                  ],
                  "description": "直した訳（name 固有名・date 日付・number 数字・quote 引用・reason 理由・overstate 言い過ぎ・notInSource 資料に無い・rule 決まり・term 用語・subject 主体・area 区域や対象・other）"
                }
              },
              "required": [
                "path",
                "set",
                "why"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 80,
                  "description": "入力の欄の道（. でつなぎ、並びは 0 から。例 summary・stakeholders.1.claim・timeline.3・terms.5.explanation）"
                },
                "remove": {
                  "type": "boolean",
                  "const": true,
                  "description": "並びの要素を消す（timeline.3・sources.1 など）"
                },
                "why": {
                  "type": "string",
                  "enum": [
                    "name",
                    "date",
                    "number",
                    "quote",
                    "reason",
                    "overstate",
                    "notInSource",
                    "rule",
                    "term",
                    "subject",
                    "area",
                    "other"
                  ],
                  "description": "直した訳（name 固有名・date 日付・number 数字・quote 引用・reason 理由・overstate 言い過ぎ・notInSource 資料に無い・rule 決まり・term 用語・subject 主体・area 区域や対象・other）"
                }
              },
              "required": [
                "path",
                "remove",
                "why"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "const": "unverified"
                },
                "add": {
                  "type": "string",
                  "minLength": 1,
                  "description": "確かめられなかった点を足す（300字まで）"
                },
                "why": {
                  "type": "string",
                  "enum": [
                    "name",
                    "date",
                    "number",
                    "quote",
                    "reason",
                    "overstate",
                    "notInSource",
                    "rule",
                    "term",
                    "subject",
                    "area",
                    "other"
                  ],
                  "description": "直した訳（name 固有名・date 日付・number 数字・quote 引用・reason 理由・overstate 言い過ぎ・notInSource 資料に無い・rule 決まり・term 用語・subject 主体・area 区域や対象・other）"
                }
              },
              "required": [
                "path",
                "add",
                "why"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "path": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 80,
                  "description": "入力の欄の道（. でつなぎ、並びは 0 から。例 summary・stakeholders.1.claim・timeline.3・terms.5.explanation）"
                },
                "emphasis": {
                  "maxItems": 3,
                  "type": "array",
                  "items": {
                    "type": "string"
                  },
                  "description": "強調を入れ替える（直した数に数えない）"
                }
              },
              "required": [
                "path",
                "emphasis"
              ],
              "additionalProperties": false
            }
          ]
        },
        "description": "直す所（60まで。全部当たるか、何も当てない）"
      },
      "reject": {
        "description": "元の資料で確かめられず版に入れない時の短い訳（200字まで）",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    },
    "required": [
      "runId",
      "draft",
      "model",
      "claims",
      "patches"
    ]
  },
  "topic_add_topics": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "items": {
        "minItems": 1,
        "maxItems": 5,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "draft": {
              "type": "string",
              "minLength": 1,
              "maxLength": 20,
              "description": "下書きの id（d:01 の形。topic_save_draft の答え・topic_list_drafts で分かる）"
            },
            "rank": {
              "type": "integer",
              "minimum": 1,
              "maximum": 30,
              "description": "版の中の順位（1〜30）"
            }
          },
          "required": [
            "draft",
            "rank"
          ]
        },
        "description": "足す照合済みの下書き（1〜5件）"
      }
    },
    "required": [
      "runId",
      "items"
    ]
  },
  "topic_add_edition": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "order": {
        "minItems": 1,
        "maxItems": 30,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 60
        },
        "description": "版の話題の並び（1〜30件。p:… か、足した下書きの d:…）"
      },
      "candidateCount": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000,
        "description": "候補の数（topic_list_candidates の読める候補の数）"
      },
      "notChosen": {
        "default": [],
        "description": "選ばなかった候補（20件まで）",
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "headline": {
              "type": "string",
              "description": "選ばなかった候補の見出し（120字まで）"
            },
            "whyNot": {
              "type": "string",
              "description": "選ばなかった訳（150字まで）"
            }
          },
          "required": [
            "headline",
            "whyNot"
          ]
        }
      },
      "tokens": {
        "description": "使用量（分かる時だけ）",
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "runId",
      "order",
      "candidateCount"
    ]
  },
  "topic_add_edition_fail": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "reasonKind": {
        "type": "string",
        "enum": [
          "quota",
          "outage",
          "timeout",
          "no-sources",
          "other"
        ],
        "description": "作れなかった訳の種類（quota 使用量の上限・outage 障害・timeout 時間切れ・no-sources 読める資料が足りない・other）"
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "画面に出す短い訳（200字まで）"
      }
    },
    "required": [
      "runId",
      "reasonKind",
      "reason"
    ]
  },
  "topic_add_correction": {
    "type": "object",
    "properties": {
      "runId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "topic_begin_run が返した回の id（r202611191016-ab12 の形）"
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "使っているモデルの名前（60字まで。記録の model に入る）"
      },
      "topic": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "話題の指し方（p:＋8字の短い id か、話題の id そのもの）"
      },
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 300,
        "description": "何がどう誤りで、正しくは何か（ふつうの文。300字まで）"
      }
    },
    "required": [
      "runId",
      "model",
      "topic",
      "text"
    ]
  }
}

export const ADD_OUTPUT_SCHEMA: Record<string, unknown> = {
  "type": "object",
  "properties": {
    "created": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "label"
        ]
      }
    },
    "skipped": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "ref": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        },
        "required": [
          "ref",
          "reason"
        ]
      }
    }
  },
  "required": [
    "created",
    "skipped"
  ]
}
