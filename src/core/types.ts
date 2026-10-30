export interface Comment {
  id: string;
  authorId: string;
  username: string;
  text: string;
  createdAt: string;
  parentId: string | null;
}
export interface Post {
  shortcode: string;
  url: string;
  owner?: string;
  id?: string;
  reportedCount?: number;
}
export interface Rules {
  text: string;
  minTags: number;
  deadline: string | null;
  mode: "person" | "friends";
  repeatWinners: boolean;
}
export interface Prize {
  id: string;
  name: string;
  quantity: number;
}
export interface Decision {
  commentId: string;
  authorId: string;
  username: string;
  eligible: boolean;
  ticket: boolean;
  tags: string[];
  newTags: string[];
  reason: string;
}
export interface Ticket {
  id: string;
  commentId: string;
  authorId: string;
  username: string;
}
export interface Evaluation {
  decisions: Decision[];
  tickets: Ticket[];
  eligibleAccounts: number;
}
export interface Winner extends Ticket {
  prizeId: string;
  prizeName: string;
  position: number;
}
export interface DrawRecord {
  id: string;
  activityId: string;
  createdAt: string;
  post: Post;
  rules: Rules;
  prizes: Prize[];
  comments: Comment[];
  evaluation: Evaluation;
  winners: Winner[];
  randomAlgorithm: "crypto-u32-rejection-v1";
  demo: boolean;
}
export interface Page {
  comments: Comment[];
  next: string | null;
  replyParents: { id: string; expected?: number }[];
  expected?: number;
}
export interface CrawlTask {
  key: string;
  parentId: string | null;
  cursor: string | null;
  seen: string[];
  done: boolean;
  receivedIds: string[];
  expected?: number;
  rechecks?: number;
  countMismatch?: boolean;
}
export interface Activity {
  id: string;
  post: Post;
  createdAt: string;
  updatedAt: string;
  status:
    "ready" | "running" | "paused" | "cancelled" | "complete" | "discrepancy";
  tasks: CrawlTask[];
  pages: number;
  commentCount: number;
  message: string;
  rules: Rules;
  prizes: Prize[];
  demo: boolean;
}
export const defaultRules: Rules = {
  text: "",
  minTags: 0,
  deadline: null,
  mode: "person",
  repeatWinners: false,
};
