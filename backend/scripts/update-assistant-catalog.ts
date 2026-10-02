/** 文档中的目录是生成快照；运行权威仍为 contracts/page-catalog 与 TOOL_REGISTRY。 */
import fs from 'fs';
import path from 'path';
import { PAGE_CATALOG } from '../src/contracts/page-catalog';
import { TOOL_REGISTRY, toolDefinitions } from '../src/assistant/tools';
const file = path.resolve(__dirname, '../assistant-openapi.json');
const document = JSON.parse(fs.readFileSync(file, 'utf8'));
document['x-page-capabilities'] = PAGE_CATALOG;
document['x-readonly-tools'] = toolDefinitions.map((tool) => ({ ...tool, selectionModes: TOOL_REGISTRY[tool.function.name as keyof typeof TOOL_REGISTRY].selectionModes ?? [] }));
document.components.schemas.PageContext.properties.pageKey.enum = Object.keys(PAGE_CATALOG);
document.components.schemas.AssistantScope.properties.pageKey.enum = Object.keys(PAGE_CATALOG);
fs.writeFileSync(file, JSON.stringify(document, null, 2) + '\n');
