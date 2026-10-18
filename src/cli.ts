import { SkillCatalog } from './skills.ts';
import { roots, recommendations } from './config.ts';
const catalog=new SkillCatalog(roots());await catalog.scan();
const recommended=await recommendations();
console.log(JSON.stringify({recommended,installed:catalog.grouped('installed')},null,2));
