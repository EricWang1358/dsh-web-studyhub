export interface SkeletonSummary {
  id: string;
  title: string;
  nodes: number;
  relations: number;
  sequences?: number;
  cardIds?: string[];
  decks?: number;
  scope?: Array<{ deckId: string; topic?: string; cardId?: string }>;
  updatedAt?: string;
}

export interface SkeletonCardRef {
  deckId: string;
  cardId: string;
}

export interface SkeletonNode {
  id: string;
  term: string;
  meaning: string;
  attributes?: string[];
  parent?: string;
  cards: SkeletonCardRef[];
}

export interface SkeletonRelation {
  from: string;
  to: string;
  type: 'part-of' | 'causes' | 'contrasts' | 'prerequisite' | 'example-of' | 'related' | string;
  note?: string;
}

export interface SkeletonDetail {
  id: string;
  title: string;
  overview?: string;
  scope: Array<{ deckId: string; topic?: string; cardId?: string }>;
  nodes: SkeletonNode[];
  relations: SkeletonRelation[];
  classNote?: string;
  updatedAt?: string;
}

export interface SkeletonTopicItem {
  key: string;
  topic: string;
  count: number;
  decks: Array<{ deckId: string; deckTitle: string; count: number }>;
}

export interface FocusProgressTopic {
  topic: string;
  cards: number;
  mastery: number;
  status: 'none' | 'weak' | 'todo' | 'active' | 'done';
}

export interface CardMasteryInfo {
  deckId: string;
  cardId: string;
  topic: string;
  prompt: string;
  level: 'mastered' | 'familiar' | 'learning' | 'weak' | 'new';
}

export interface NodeStats {
  cardCount: number;
  masteredCount: number;
  weakCount: number;
  masteryPct: number;
  isFocus: boolean;
  level: 'mastered' | 'learning' | 'weak' | 'new';
  samplePrompts: string[];
  subtreeCards: SkeletonCardRef[];
}
