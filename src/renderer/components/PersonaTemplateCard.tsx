import type { AgentCapability } from "../../electron/preload";
import { resolveTwinIcon } from "../utils/twin-icons";

interface PersonaTemplateData {
  id: string;
  version: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  category: string;
  role: {
    capabilities: AgentCapability[];
    autonomyLevel: string;
    personalityId: string;
    systemPrompt: string;
    soul: string;
  };
  skills: Array<{ skillId: string; reason: string; required: boolean }>;
  tags: string[];
  seniorityRange: string[];
  industryAgnostic: boolean;
}

export type { PersonaTemplateData };

const CAPABILITY_LABELS: Record<string, string> = {
  code: "Code",
  review: "Review",
  research: "Research",
  test: "Test",
  document: "Document",
  plan: "Plan",
  design: "Design",
  analyze: "Analyze",
  ops: "DevOps",
  security: "Security",
  write: "Write",
  communicate: "Communicate",
  market: "Marketing",
  manage: "Manage",
  product: "Product",
};

interface PersonaTemplateCardProps {
  template: PersonaTemplateData;
  onActivate: (template: PersonaTemplateData) => void;
}

export function PersonaTemplateCard({ template, onActivate }: PersonaTemplateCardProps) {
  const capabilities = template.role?.capabilities ?? [];
  const skills = template.skills ?? [];

  return (
    <div className="pt-card" onClick={() => onActivate(template)}>
      <div className="pt-card-header">
        <span className="pt-card-icon">
          {(() => {
            const Icon = resolveTwinIcon(template.icon);
            return <Icon size={18} strokeWidth={2} />;
          })()}
        </span>
        <span className="pt-card-name">{template.name}</span>
      </div>

      <p className="pt-card-description">{template.description}</p>

      <div className="pt-card-tags">
        {capabilities.slice(0, 4).map((cap) => (
          <span key={cap} className="pt-tag">
            {CAPABILITY_LABELS[cap] || cap}
          </span>
        ))}
        {capabilities.length > 4 && <span className="pt-tag">+{capabilities.length - 4}</span>}
      </div>

      <div className="pt-card-footer">
        <span className="pt-card-meta">
          Persona preset &middot; {skills.length} skills &middot; {template.role.autonomyLevel}
        </span>
        <span className="pt-card-action">Activate &rarr;</span>
      </div>
    </div>
  );
}
