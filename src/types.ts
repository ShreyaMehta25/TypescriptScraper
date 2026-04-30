export interface SiteConfig {
  id: string;
  url: string;
  method: "basic" | "scroll";
  output: string;
  scroll: boolean;
  day: number;
}

export interface Grant {
  id: string;
  slug: string;
  name: string;
  provider: string;
  country: string;
  countryCode: string;
  region: string;
  amountMin: number | null;
  amountMax: number | null;
  currency: string;
  deadline: string;
  daysRemaining: number | null;
  description: string;
  fullDescription: string;
  eligibilitySnapshot: string;
  tags: string[];
  type: string;
  grantType: string;
  industry: string[];
  eligibility: string[];
  whatItCovers: string[];
  howToApply: string[];
  applicationUrl: string;
  source?: string;
}
