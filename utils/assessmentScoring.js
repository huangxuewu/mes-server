const RATING_BANDS = { Outstanding: 90, Acceptable: 80, NeedsImprovement: 70 };

const avgToPct = ratings =>
    ratings.length ? (ratings.reduce((s, r) => s + r, 0) / ratings.length) * 20 : null;

const getRatingBand = score => {
    if (score === null || score === undefined) return null;
    if (score >= RATING_BANDS.Outstanding) return "Outstanding";
    if (score >= RATING_BANDS.Acceptable) return "Acceptable";
    if (score >= RATING_BANDS.NeedsImprovement) return "NeedsImprovement";
    return "NonCompliant";
};

const computeScores = (answers = []) => {
    const bySection = {};
    const allRatings = [];

    answers.forEach(({ sectionId, rating, na }) => {
        if (na || !rating) return;
        if (!bySection[sectionId]) bySection[sectionId] = [];
        bySection[sectionId].push(rating);
        allRatings.push(rating);
    });

    const sectionScores = Object.entries(bySection).map(([sectionId, ratings]) => {
        const score = avgToPct(ratings);
        return { sectionId, score, ratingBand: getRatingBand(score) };
    });

    const overallScore = avgToPct(allRatings);

    return {
        sectionScores,
        overallScore,
        ratingBand: getRatingBand(overallScore)
    };
};

module.exports = { computeScores, getRatingBand, avgToPct, RATING_BANDS };
