# Citysignal

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: React, Vite, and a small Node server. The user asked me to choose the stack.

## Users

People in New York City looking for worthwhile upcoming events across Luma, Partiful, and NYC Parks, with mixers and social events as the top preference.

## Product Purpose

Find public upcoming NYC events, label each by source and interest, and make strong options easy to spot and open at the original listing.

## Operating Context

The site reads publicly visible discovery pages, Luma's public NYC discovery feed, and NYC Parks' public upcoming events data. Source coverage can vary because each provider controls what it exposes. Registration and tickets remain on the source platform.

## Capabilities and Constraints

The initial scope is future-starting public events within 90 days in New York City. Labels include tech, mixers, and company names only when the event's public text supports them. Ranking is a transparent heuristic that favors mixers and social gatherings. Public listing data refreshes on demand and every 15 minutes. Private or invite-only events are out of scope. The interface is simple, human, and black and white, per the user's direction.

## Evidence on Hand

Public NYC discovery pages exist at Luma, Partiful Explore, and Eventbrite; NYC Parks also publishes an upcoming public events feed. The scanner reads their structured public event data. There are no user-provided brand assets or event endorsements.

## Product Principles

- Show where each event came from.
- Let people inspect and adjust the shortlist quickly.
- Keep links and source availability visible.
- Avoid inventing hosts, prices, or company relationships.
