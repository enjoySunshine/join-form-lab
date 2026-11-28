import GlyphIterator from './GlyphIterator';
import * as Script from '../layout/Script';

const DEFAULT_SCRIPTS = ['DFLT', 'dflt', 'latn'];

// Coverage and class definition tables are immutable once decoded, so their
// per-glyph answers can be memoized for the life of the font. Long text reuses
// a handful of coverages across thousands of glyphs, where the linear scans
// otherwise dominate shaping time.
const coverageCache = new WeakMap();
const classDefCache = new WeakMap();
const lookupCoverageCache = new WeakMap();

// The coverage a subtable matches the current glyph against, i.e. the
// coverage of its first input position. Null when it has none.
function subtableCoverage(table) {
  // Follow extension wrappers (GSUB 7 / GPOS 9) to the real subtable.
  let guard = 0;
  while (table && table.extension && guard++ < 8) {
    table = table.extension;
  }

  if (!table) {
    return null;
  }

  if (table.coverage) {
    return table.coverage;
  }

  // GPOS mark attachment matches the current glyph against the mark coverage.
  if (table.markCoverage) {
    return table.markCoverage;
  }

  if (table.mark1Coverage) {
    return table.mark1Coverage;
  }

  // Coverage-based context/chaining context (format 3) key the first input
  // glyph by the first entry of their coverage arrays.
  if (table.version === 3) {
    if (table.inputCoverage && table.inputCoverage.length > 0) {
      return table.inputCoverage[0];
    }

    if (table.coverages && table.coverages.length > 0) {
      return table.coverages[0];
    }
  }

  return null;
}

// The glyphs a lookup can start a match on: the union of its subtables'
// first-input coverage. Returns null when a subtable has no such coverage
// (e.g. GPOS mark attachments, which are keyed by markCoverage), so those
// lookups are never skipped.
function lookupCoverage(lookup) {
  if (lookupCoverageCache.has(lookup)) {
    return lookupCoverageCache.get(lookup);
  }

  let set = new Set();
  let complete = true;
  for (let table of lookup.subTables) {
    let coverage = subtableCoverage(table);
    if (coverage == null) {
      complete = false;
      break;
    }

    if (coverage.version === 1) {
      for (let id of coverage.glyphs) set.add(id);
    } else if (coverage.version === 2) {
      for (let range of coverage.rangeRecords) {
        for (let id = range.start; id <= range.end; id++) set.add(id);
      }
    }
  }

  let result = complete ? set : null;
  lookupCoverageCache.set(lookup, result);
  return result;
}

export default class OTProcessor {
  constructor(font, table) {
    this.font = font;
    this.table = table;

    this.script = null;
    this.scriptTag = null;

    this.language = null;
    this.languageTag = null;

    this.features = {};
    this.lookups = {};

    // Setup variation substitutions. FeatureVariations apply at the font's
    // current location, defaulting to the normalized origin (all-zero coords)
    // when no variation is set — matching HarfBuzz, which always evaluates them.
    // fontkit only builds a _variationProcessor once coords are applied (or for
    // CFF2), so a plain variable font would otherwise skip FeatureVariations
    // (e.g. default-location bracket-layer substitutions) entirely.
    let variationCoords = font._variationProcessor
      ? font._variationProcessor.normalizedCoords
      : font.fvar
        ? new Array(font.fvar.axis.length).fill(0)
        : null;
    this.variationsIndex = variationCoords
      ? this.findVariationsIndex(variationCoords)
      : -1;

    // initialize to default script + language
    this.selectScript();

    // current context (set by applyFeatures)
    this.glyphs = [];
    this.positions = []; // only used by GPOS
    this.ligatureID = 1;
    this.currentFeature = null;
  }

  findScript(script) {
    if (this.table.scriptList == null) {
      return null;
    }

    if (!Array.isArray(script)) {
      script = [script];
    }

    for (let s of script) {
      for (let entry of this.table.scriptList) {
        if (entry.tag === s) {
          return entry;
        }
      }
    }

    return null;
  }

  selectScript(script, language, direction) {
    let changed = false;
    let entry;
    if (!this.script || script !== this.scriptTag) {
      entry = this.findScript(script);
      if (!entry) {
        entry = this.findScript(DEFAULT_SCRIPTS);
      }

      if (!entry) {
        return this.scriptTag;
      }

      this.scriptTag = entry.tag;
      this.script = entry.script;
      this.language = null;
      this.languageTag = null;
      changed = true;
    }

    if (!direction || direction !== this.direction) {
      this.direction = direction || Script.direction(script);
    }

    if (language && language.length < 4) {
      language += ' '.repeat(4 - language.length);
    }

    if (!language || language !== this.languageTag) {
      this.language = null;

      for (let lang of this.script.langSysRecords) {
        if (lang.tag === language) {
          this.language = lang.langSys;
          this.languageTag = lang.tag;
          break;
        }
      }

      if (!this.language) {
        this.language = this.script.defaultLangSys;
        this.languageTag = null;
      }

      changed = true;
    }

    // Build a feature lookup table
    if (changed) {
      this.features = {};
      if (this.language) {
        for (let featureIndex of this.language.featureIndexes) {
          let record = this.table.featureList[featureIndex];
          let substituteFeature =
            this.substituteFeatureForVariations(featureIndex);
          this.features[record.tag] = substituteFeature || record.feature;
        }
      }
    }

    return this.scriptTag;
  }

  lookupsForFeatures(userFeatures = [], exclude) {
    let lookups = [];
    for (let tag of userFeatures) {
      let feature = this.features[tag];
      if (!feature) {
        continue;
      }

      for (let lookupIndex of feature.lookupListIndexes) {
        if (exclude && exclude.indexOf(lookupIndex) !== -1) {
          continue;
        }

        lookups.push({
          feature: tag,
          index: lookupIndex,
          lookup: this.table.lookupList.get(lookupIndex),
        });
      }
    }

    lookups.sort((a, b) => a.index - b.index);
    return lookups;
  }

  substituteFeatureForVariations(featureIndex) {
    if (this.variationsIndex === -1) {
      return null;
    }

    let record =
      this.table.featureVariations.featureVariationRecords[
        this.variationsIndex
      ];
    let substitutions = record.featureTableSubstitution.substitutions;
    for (let substitution of substitutions) {
      if (substitution.featureIndex === featureIndex) {
        return substitution.alternateFeatureTable;
      }
    }

    return null;
  }

  findVariationsIndex(coords) {
    let variations = this.table.featureVariations;
    if (!variations) {
      return -1;
    }

    let records = variations.featureVariationRecords;
    for (let i = 0; i < records.length; i++) {
      let conditions = records[i].conditionSet.conditionTable;
      if (this.variationConditionsMatch(conditions, coords)) {
        return i;
      }
    }

    return -1;
  }

  variationConditionsMatch(conditions, coords) {
    return conditions.every((condition) => {
      let coord =
        condition.axisIndex < coords.length ? coords[condition.axisIndex] : 0;
      return (
        condition.filterRangeMinValue <= coord &&
        coord <= condition.filterRangeMaxValue
      );
    });
  }

  applyFeatures(featureTags, glyphs, advances, userFeatures) {
    this.userFeatures = userFeatures;
    let lookups = this.lookupsForFeatures(featureTags);
    this.applyLookups(lookups, glyphs, advances);
  }

  applyLookups(lookups, glyphs, positions) {
    this.glyphs = glyphs;
    this.positions = positions;
    this.glyphIterator = new GlyphIterator(glyphs);

    // Substitutions replace glyphs in place, so this id set is rebuilt
    // whenever one succeeds and any later lookup needs it.
    let present = null;
    let presentStale = true;

    for (let { feature, lookup } of lookups) {
      this.currentFeature = feature;

      // Glyphs the lookup can possibly match. Everything else would only
      // fail its coverage test, so skip it without entering the subtables.
      let coverage = lookupCoverage(lookup);
      if (coverage !== null) {
        if (presentStale) {
          present = new Set();
          for (let glyph of glyphs) present.add(glyph.id);
          presentStale = false;
        }

        let intersects = false;
        for (let id of coverage) {
          if (present.has(id)) {
            intersects = true;
            break;
          }
        }

        if (!intersects) {
          continue;
        }
      }

      let direction = this.isReverseLookup(lookup) ? -1 : 1;
      let startIndex = direction === -1 ? glyphs.length - 1 : 0;
      let flags = lookup.flags.flags;
      let skipsGlyphs =
        flags.ignoreBaseGlyphs ||
        flags.ignoreLigatures ||
        flags.ignoreMarks ||
        flags.useMarkFilteringSet ||
        lookup.flags.markAttachmentType;

      this.glyphIterator.reset(
        lookup.flags,
        startIndex,
        skipsGlyphs ? this.getMarkFilteringSet(lookup) : null,
      );

      let index = startIndex;
      while (index >= 0 && index < glyphs.length) {
        let glyph = glyphs[index];
        this.glyphIterator.index = index;
        if (
          feature in glyph.features &&
          (coverage === null || coverage.has(glyph.id))
        ) {
          for (let table of lookup.subTables) {
            if (this.applyLookup(lookup.lookupType, table)) {
              presentStale = true;
              break;
            }
          }

          // Substitutions may delete or insert glyphs and move the cursor.
          index = this.glyphIterator.index;
        }

        // A lookup without ignoring flags visits every glyph, so walk the
        // buffer directly instead of going through the iterator's skip logic.
        if (skipsGlyphs) {
          this.glyphIterator.move(direction);
          index = this.glyphIterator.index;
        } else {
          index += direction;
        }
      }
    }
  }

  // Return whether a subtable matched. On success, leave glyphIterator immediately
  // before the continuation position: applyLookups calls next() after the lookup.
  // Contextual lookups reset the cursor and flags before each nested lookup and
  // determine their own continuation after the matched input sequence.
  applyLookup(lookup, table) {
    throw new Error('applyLookup must be implemented by subclasses');
  }

  // Return whether a lookup is applied right-to-left
  isReverseLookup(lookup) {
    return false;
  }

  applyLookupList(lookupRecords, inputLength) {
    let options = this.glyphIterator.options;
    let markFilteringSet = this.glyphIterator.markFilteringSet;
    let glyphIndex = this.glyphIterator.index;

    // Index just past the matched input sequence, moved as the
    // lookups below insert or delete glyphs
    let end = this.glyphIterator.peekIndex(inputLength - 1) + 1;

    for (let lookupRecord of lookupRecords) {
      // Reset flags and find glyph index for this lookup record
      this.glyphIterator.reset(options, glyphIndex, markFilteringSet);
      this.glyphIterator.increment(lookupRecord.sequenceIndex);
      let index = this.glyphIterator.index;

      // Get the lookup and setup flags for subtables
      let lookup = this.table.lookupList.get(lookupRecord.lookupListIndex);
      this.glyphIterator.reset(
        lookup.flags,
        index,
        this.getMarkFilteringSet(lookup),
      );

      // Apply lookup subtables until one matches
      let length = this.glyphs.length;
      for (let table of lookup.subTables) {
        if (this.applyLookup(lookup.lookupType, table)) {
          break;
        }
      }

      // Like HarfBuzz, never move the end before the glyph this lookup applied to
      end = Math.max(end + this.glyphs.length - length, index);
    }

    // Continue after the input sequence, so this lookup is not applied
    // again to glyphs it already matched or produced
    this.glyphIterator.reset(options, end - 1, markFilteringSet);
    return true;
  }

  getMarkFilteringSet(lookup) {
    if (!lookup.flags.flags.useMarkFilteringSet) {
      return null;
    }
    let coverage =
      this.font.GDEF?.markGlyphSetsDef?.coverage?.[lookup.markFilteringSet];
    if (!coverage) {
      return null;
    }
    let cache = (this._coverageSetCache ??= new Map());
    let set = cache.get(coverage);
    if (!set) {
      set = new Set();
      if (coverage.glyphs) {
        for (let id of coverage.glyphs) set.add(id);
      } else if (coverage.rangeRecords) {
        for (let { start, end } of coverage.rangeRecords) {
          for (let id = start; id <= end; id++) set.add(id);
        }
      }
      cache.set(coverage, set);
    }
    return set;
  }

  coverageIndex(coverage, glyph) {
    if (glyph == null) {
      glyph = this.glyphIterator.cur.id;
    }

    switch (coverage.version) {
      case 1: {
        let map = coverageCache.get(coverage);
        if (map == null) {
          map = new Map();
          let glyphs = coverage.glyphs;
          for (let i = 0; i < glyphs.length; i++) {
            // Match indexOf: the first occurrence wins if a font repeats an id.
            if (!map.has(glyphs[i])) {
              map.set(glyphs[i], i);
            }
          }

          coverageCache.set(coverage, map);
        }

        let index = map.get(glyph);
        return index === undefined ? -1 : index;
      }

      case 2: {
        // Ranges are sorted and disjoint, so binary search instead of
        // scanning them, memoized per coverage table.
        let ranges = coverage.rangeRecords;
        let low = 0;
        let high = ranges.length - 1;
        while (low <= high) {
          let mid = (low + high) >>> 1;
          let range = ranges[mid];
          if (glyph < range.start) {
            high = mid - 1;
          } else if (glyph > range.end) {
            low = mid + 1;
          } else {
            return range.startCoverageIndex + glyph - range.start;
          }
        }

        break;
      }
    }

    return -1;
  }

  match(sequenceIndex, sequence, fn, matched) {
    let pos = this.glyphIterator.index;
    let glyph = this.glyphIterator.increment(sequenceIndex);
    let idx = 0;

    while (idx < sequence.length && glyph && fn(sequence[idx], glyph)) {
      if (matched) {
        matched.push(this.glyphIterator.index);
      }

      idx++;
      glyph = this.glyphIterator.next();
    }

    this.glyphIterator.index = pos;
    if (idx < sequence.length) {
      return false;
    }

    return matched || true;
  }

  sequenceMatches(sequenceIndex, sequence) {
    let pos = this.glyphIterator.index;
    let glyph = this.glyphIterator.increment(sequenceIndex);
    let idx = 0;
    while (idx < sequence.length && glyph && sequence[idx] === glyph.id) {
      idx++;
      glyph = this.glyphIterator.next();
    }

    this.glyphIterator.index = pos;
    return idx === sequence.length;
  }

  sequenceMatchIndices(sequenceIndex, sequence) {
    return this.match(
      sequenceIndex,
      sequence,
      (component, glyph) => {
        // If the current feature doesn't apply to this glyph,
        if (!(this.currentFeature in glyph.features)) {
          return false;
        }

        return component === glyph.id;
      },
      [],
    );
  }

  coverageSequenceMatches(sequenceIndex, sequence) {
    let pos = this.glyphIterator.index;
    let glyph = this.glyphIterator.increment(sequenceIndex);
    let idx = 0;
    while (
      idx < sequence.length &&
      glyph &&
      this.coverageIndex(sequence[idx], glyph.id) >= 0
    ) {
      idx++;
      glyph = this.glyphIterator.next();
    }

    this.glyphIterator.index = pos;
    return idx === sequence.length;
  }

  getClassID(glyph, classDef) {
    switch (classDef.version) {
      case 1: // Class array
        let i = glyph - classDef.startGlyph;
        if (i >= 0 && i < classDef.classValueArray.length) {
          return classDef.classValueArray[i];
        }

        break;

      case 2: {
        let map = classDefCache.get(classDef);
        if (map == null) {
          map = new Map();
          classDefCache.set(classDef, map);
        }

        let cls = map.get(glyph);
        if (cls !== undefined) {
          return cls;
        }

        cls = 0;
        for (let range of classDef.classRangeRecord) {
          if (range.start <= glyph && glyph <= range.end) {
            cls = range.class;
            break;
          }
        }

        map.set(glyph, cls);
        return cls;
      }
    }

    return 0;
  }

  classSequenceMatches(sequenceIndex, sequence, classDef) {
    let pos = this.glyphIterator.index;
    let glyph = this.glyphIterator.increment(sequenceIndex);
    let idx = 0;
    while (
      idx < sequence.length &&
      glyph &&
      sequence[idx] === this.getClassID(glyph.id, classDef)
    ) {
      idx++;
      glyph = this.glyphIterator.next();
    }

    this.glyphIterator.index = pos;
    return idx === sequence.length;
  }

  // Backtrack arrays are stored in reverse order per the OpenType spec.
  // Match them by walking backwards from the current glyph instead of
  // reversing a copy and walking forwards to the same positions.
  coverageSequenceMatchesBackwards(sequence) {
    let pos = this.glyphIterator.index;
    let idx = 0;
    let matched = true;
    this.glyphIterator.index = pos;
    while (idx < sequence.length) {
      this.glyphIterator.move(-1);
      let glyph = this.glyphIterator.cur;
      if (!glyph || this.coverageIndex(sequence[idx], glyph.id) < 0) {
        matched = false;
        break;
      }

      idx++;
    }

    this.glyphIterator.index = pos;
    return matched;
  }

  sequenceMatchesBackwards(sequence) {
    let pos = this.glyphIterator.index;
    let idx = 0;
    let matched = true;
    this.glyphIterator.index = pos;
    while (idx < sequence.length) {
      this.glyphIterator.move(-1);
      let glyph = this.glyphIterator.cur;
      if (!glyph || sequence[idx] !== glyph.id) {
        matched = false;
        break;
      }

      idx++;
    }

    this.glyphIterator.index = pos;
    return matched;
  }

  classSequenceMatchesBackwards(sequence, classDef) {
    let pos = this.glyphIterator.index;
    let idx = 0;
    let matched = true;
    this.glyphIterator.index = pos;
    while (idx < sequence.length) {
      this.glyphIterator.move(-1);
      let glyph = this.glyphIterator.cur;
      if (!glyph || sequence[idx] !== this.getClassID(glyph.id, classDef)) {
        matched = false;
        break;
      }

      idx++;
    }

    this.glyphIterator.index = pos;
    return matched;
  }

  applyContext(table) {
    let index, set;
    switch (table.version) {
      case 1:
        index = this.coverageIndex(table.coverage);
        if (index === -1) {
          return false;
        }

        set = table.ruleSets[index];
        for (let rule of set) {
          if (this.sequenceMatches(1, rule.input)) {
            return this.applyLookupList(rule.lookupRecords, rule.glyphCount);
          }
        }

        break;

      case 2:
        if (this.coverageIndex(table.coverage) === -1) {
          return false;
        }

        index = this.getClassID(this.glyphIterator.cur.id, table.classDef);
        if (index === -1) {
          return false;
        }

        set = table.classSet[index];
        for (let rule of set) {
          if (this.classSequenceMatches(1, rule.classes, table.classDef)) {
            return this.applyLookupList(rule.lookupRecords, rule.glyphCount);
          }
        }

        break;

      case 3:
        if (this.coverageSequenceMatches(0, table.coverages)) {
          return this.applyLookupList(table.lookupRecords, table.glyphCount);
        }

        break;
    }

    return false;
  }

  applyChainingContext(table) {
    let index;
    switch (table.version) {
      case 1:
        index = this.coverageIndex(table.coverage);
        if (index === -1) {
          return false;
        }

        let set = table.chainRuleSets[index];
        for (let rule of set) {
          if (
            this.sequenceMatchesBackwards(rule.backtrack) &&
            this.sequenceMatches(1, rule.input) &&
            this.sequenceMatches(1 + rule.input.length, rule.lookahead)
          ) {
            return this.applyLookupList(
              rule.lookupRecords,
              rule.inputGlyphCount,
            );
          }
        }

        break;

      case 2:
        if (this.coverageIndex(table.coverage) === -1) {
          return false;
        }

        index = this.getClassID(this.glyphIterator.cur.id, table.inputClassDef);
        let rules = table.chainClassSet[index];
        if (!rules) {
          return false;
        }

        for (let rule of rules) {
          if (
            this.classSequenceMatchesBackwards(
              rule.backtrack,
              table.backtrackClassDef,
            ) &&
            this.classSequenceMatches(1, rule.input, table.inputClassDef) &&
            this.classSequenceMatches(
              1 + rule.input.length,
              rule.lookahead,
              table.lookaheadClassDef,
            )
          ) {
            return this.applyLookupList(
              rule.lookupRecords,
              rule.inputGlyphCount,
            );
          }
        }

        break;

      case 3:
        if (
          this.coverageSequenceMatchesBackwards(table.backtrackCoverage) &&
          this.coverageSequenceMatches(0, table.inputCoverage) &&
          this.coverageSequenceMatches(
            table.inputGlyphCount,
            table.lookaheadCoverage,
          )
        ) {
          return this.applyLookupList(
            table.lookupRecords,
            table.inputGlyphCount,
          );
        }

        break;
    }

    return false;
  }
}
