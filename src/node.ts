import { QName } from './xsd/model.js';
import type { ElementDecl, TypeDef } from './xsd/model.js';

export interface AttrNode {
  name: QName;
  value: string;
}

export interface TextNode {
  kind: 'text';
  value: string;
}

export interface CommentNode {
  kind: 'comment';
  value: string;
}

export interface ElementNode {
  kind: 'element';
  name: QName;
  attributes: AttrNode[];
  children: ChildNode[];
  nil: boolean;
  /** Type selected with xsi:type. */
  xsiType?: QName;
  decl?: ElementDecl;
  /** Effective type (declared type, or the xsi:type override). */
  type?: TypeDef;
  line?: number;
}

export type ChildNode = ElementNode | TextNode | CommentNode;

export function childElements(n: ElementNode): ElementNode[] {
  return n.children.filter((c): c is ElementNode => c.kind === 'element');
}

export function textContent(n: ElementNode): string {
  return n.children.map((c) => (c.kind === 'text' ? c.value : '')).join('');
}
