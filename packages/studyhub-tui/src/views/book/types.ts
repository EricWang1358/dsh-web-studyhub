export interface BookQuestionRef {
  deckId: string;
  cardId: string;
  prompt?: string;
}

export interface BookNode {
  hid: string;
  key: string;
  title: string;
  number: string;
  depth: number;
  leaf?: boolean;
  gen?: string;
  mine?: string;
  qa?: string;
  short?: boolean;
  unbuilt?: boolean;
  movedFrom?: string;
  prereqHids?: string[];
  retold?: { count?: number; lastAt?: string };
  files?: { gen?: string; mine?: string; qa?: string };
  questionTotal?: number;
  questions?: BookQuestionRef[];
  children?: BookNode[];
}

export interface BookOpenResult {
  status: 'ok' | 'empty' | 'rebuild-pending';
  course?: string | null;
  reason?: string;
  revision?: number;
  title?: string;
  language?: string;
  notes?: boolean;
  papers?: number;
  outdated?: boolean;
  nodes?: BookNode[];
  unplaced?: {
    title?: string;
    text?: string;
    file?: string;
    sections?: Array<{ id: string; title: string; chars: number }>;
  };
  moves?: {
    outlineId?: string;
    total?: number;
    held?: number;
    gone?: number;
    undoable?: boolean;
  };
  coverage?: {
    materials?: { opened?: number; total?: number };
    points?: { complete?: number; total?: number };
    concepts?: { covered?: number; total?: number };
  };
}

export interface BookTocRow {
  hid: string;
  n: string;
  title: string;
  chapter?: boolean;
  forked?: boolean;
  read?: string;
  cited?: number;
  concepts?: string;
  short?: boolean;
  files?: Record<string, { v: number; words: number }>;
}

export interface BookTocResult {
  status: 'ok' | 'empty' | 'rebuild-pending';
  course?: string | null;
  reason?: string;
  title?: string;
  language?: string;
  points?: number;
  rows?: number;
  nextOffset?: number | null;
  toc?: BookTocRow[];
}

export interface BookReadFileView {
  name: string;
  version?: number;
  forked?: boolean;
  words?: number;
  chars?: number;
  text: string;
  truncated?: boolean;
  nextOffset?: number;
}

export interface BookReadResult {
  status: 'ok' | 'empty';
  course?: string | null;
  hid?: string;
  n?: string;
  title?: string;
  path?: string[];
  files?: {
    gen?: BookReadFileView;
    mine?: BookReadFileView;
    qa?: BookReadFileView;
    unplaced?: BookReadFileView;
  };
  materials?: Array<{ documentId: string; title: string; pages?: string }>;
  reading?: { opened?: number; pages?: number; cited?: number };
}

export interface BookQaListResult {
  followupIds?: string[];
  answerCardIds?: string[];
  courses?: string[];
}

export interface FlatTocItem {
  hid: string;
  key: string;
  number: string;
  title: string;
  depth: number;
  leaf: boolean;
  questionTotal: number;
  unbuilt: boolean;
  short: boolean;
  hasQa: boolean;
  hasMine: boolean;
  retoldCount: number;
  node?: BookNode;
  tocRow?: BookTocRow;
}
