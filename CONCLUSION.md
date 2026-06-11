# Conclusion Memo: Blog Platform Direction for simonswanderlust

Date: February 7, 2026
Decision owner: simonswanderlust
Decision type: Platform + implementation path

## Final Decision

Choose **Astro** as the long-term platform.

For lowest migration risk, use a **two-step path**:
1. Build the Polarsteps-like map as a standalone Astro app first (subdomain).
2. Migrate the full blog from WordPress to Astro after validating the workflow.

## Why This Decision

This decision optimizes for the priorities that matter most for a developer-run travel blog:

- **Lower maintenance burden**: no WordPress core/plugin update treadmill, smaller security surface, no PHP+DB runtime.
- **Better fit for your workflow**: Markdown + Git is a native Astro workflow, not an add-on.
- **Performance headroom**: static output with selective hydration for map components.
- **Lower baseline cost**: static hosting can stay near $0/month, plus domain cost.
- **Cleaner map implementation**: one modern frontend context instead of WordPress admin/frontend split.

## What We Are Not Choosing

- **Not choosing a custom WordPress plugin as the primary direction**: this has higher implementation and maintenance complexity for your use case.
- **Not choosing WordPress+Git+Markdown sync plugins as a strategic foundation**: workable, but brittle and operationally heavier than moving to a static architecture.

## Tradeoffs Accepted

- Migration effort from WordPress content to Markdown.
- Replacing some WordPress-native features (comments, forms, search) with focused services/tools.
- Less visual-CMS comfort out of the box (acceptable for a developer-run site).

## Execution Plan

1. **Map pilot (now)**: Build standalone Astro + Leaflet map on a subdomain to validate UX and data model.
2. **Content migration (next)**: Export WordPress posts, convert/clean Markdown, preserve permalink structure.
3. **Feature parity (then)**: Add search, comments, forms, analytics replacements.
4. **Cutover**: Move primary domain to Astro and keep strict redirects for any changed URLs.
5. **Post-cutover hardening**: Verify SEO, performance, and analytics continuity.

## Success Criteria

- Authoring flow is faster than current WordPress workflow.
- Travel map UX is clearly better than plugin-based alternatives.
- Ongoing monthly platform cost is reduced.
- No major SEO regressions after cutover.

## Revisit Triggers

Revisit this decision only if one of these becomes true:
- Multiple non-technical editors require heavy visual CMS workflows.
- You need a WordPress-only plugin capability that has no practical Astro alternative.
- Business requirements change toward complex dynamic app behavior that static-first architecture cannot serve cleanly.
