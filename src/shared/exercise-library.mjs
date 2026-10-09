// Training Plans — the FitFlex exercise library.
//
// Each entry is plain data so it can move into a table (and an admin
// screen) later without changing its shape:
//
//   id               stable id, never reused
//   name             English name
//   description      one line on what it is
//   category         EXERCISE_CATEGORIES
//   targetAreas      main areas worked (TARGET_AREAS)
//   secondaryAreas   areas that help
//   movementPattern  MOVEMENT_PATTERNS (optional)
//   difficulty       EXPERIENCE_LEVELS — the lowest level it suits
//   equipment        every item needed (EQUIPMENT); ['none'] = bodyweight
//   environment      where it can be done (EXERCISE_ENVIRONMENTS)
//   suitableGoals    FITNESS_GOAL_IDS it serves
//   defaultSets, defaultReps | defaultDuration (seconds), restSeconds
//   tracksWeight     a load (kg) is worth recording
//   instructions     short steps, in order
//   alternatives     ids of exercises that keep the same intent
//   active           false hides it from new plans; old workouts keep it
//   i18n             { sw: { name, description, instructions } } when translated
//
// Entries are written with `ex()` below to keep the list readable; what it
// returns is the plain shape above.
import {
  EXERCISE_CATEGORIES, EXERCISE_ENVIRONMENTS, EXPERIENCE_LEVELS, EQUIPMENT, FITNESS_GOAL_IDS,
  MOVEMENT_PATTERNS, TARGET_AREAS, availableEquipment,
} from './training-taxonomy.mjs';

const ANYWHERE = ['gym', 'home', 'outdoor'];
const INDOORS = ['gym', 'home'];
const GYM = ['gym'];
// Which goals an exercise serves.
const MUSCLE = ['gain_muscle', 'build_muscle', 'stay_fit'];
const BASICS = [...MUSCLE, 'lose_weight', 'learn_new_skill'];
const CARDIO = ['lose_weight', 'improve_endurance', 'stay_fit'];
const CALM = ['improve_flexibility', 'stress_relief', 'stay_fit'];

/**
 * One library entry. `reps` or `secs` (never both); `kg` when a load is
 * worth recording; `gear` defaults to bodyweight, `where` to anywhere.
 */
function ex(id, name, description, o) {
  return {
    id: `ex_${id}`, name, description,
    category: o.cat ?? 'strength',
    targetAreas: o.areas,
    secondaryAreas: o.also ?? [],
    movementPattern: o.pattern ?? null,
    difficulty: o.level ?? 'beginner',
    equipment: o.gear ?? ['none'],
    environment: o.where ?? ANYWHERE,
    suitableGoals: o.goals,
    defaultSets: o.sets ?? 3,
    ...(o.secs ? { defaultDuration: o.secs } : { defaultReps: o.reps ?? 10 }),
    restSeconds: o.rest ?? 60,
    tracksWeight: o.kg === true,
    instructions: o.how,
    alternatives: (o.alts ?? []).map(a => `ex_${a}`),
    active: true,
  };
}

export const EXERCISES = [
  // ── Chest ───────────────────────────────────────────────────────────────
  ex('push_up', 'Push-up', 'A bodyweight press for the chest, shoulders and arms.', {
    areas: ['chest'], also: ['triceps', 'shoulders', 'abs'], pattern: 'push', goals: BASICS,
    how: ['Hands under your shoulders, body in one straight line.', 'Lower your chest to just above the floor.', 'Press back up without letting your hips sag.'],
    alts: ['incline_push_up', 'dumbbell_bench_press', 'band_chest_press'] }),
  ex('incline_push_up', 'Incline Push-up', 'An easier push-up with your hands on a bench or step.', {
    areas: ['chest'], also: ['triceps', 'shoulders'], pattern: 'push', goals: BASICS, reps: 12,
    how: ['Hands on a sturdy bench, step or table edge.', 'Lower your chest to the edge, body straight.', 'Press back up.'],
    alts: ['push_up', 'band_chest_press'] }),
  ex('bench_press', 'Barbell Bench Press', 'The classic barbell press for the chest.', {
    areas: ['chest'], also: ['triceps', 'shoulders'], pattern: 'push', level: 'intermediate', gear: ['free_weights'], where: GYM, goals: MUSCLE, rest: 90, kg: true,
    how: ['Lie with your eyes under the bar and feet flat.', 'Lower the bar to mid-chest with control.', 'Press back up until your arms are straight.'],
    alts: ['dumbbell_bench_press', 'machine_chest_press', 'push_up'] }),
  ex('dumbbell_bench_press', 'Dumbbell Bench Press', 'A chest press with a dumbbell in each hand.', {
    areas: ['chest'], also: ['triceps', 'shoulders'], pattern: 'push', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, rest: 75, kg: true,
    how: ['Lie back with a dumbbell above each shoulder.', 'Lower them to the sides of your chest.', 'Press up and together.'],
    alts: ['bench_press', 'machine_chest_press', 'push_up'] }),
  ex('incline_dumbbell_press', 'Incline Dumbbell Press', 'A press on an inclined bench for the upper chest.', {
    areas: ['chest'], also: ['shoulders', 'triceps'], pattern: 'push', level: 'intermediate', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, rest: 75, kg: true,
    how: ['Set the bench to a gentle incline.', 'Press the dumbbells up from your upper chest.', 'Lower them slowly.'],
    alts: ['dumbbell_bench_press', 'push_up'] }),
  ex('machine_chest_press', 'Machine Chest Press', 'A guided press that is easy to learn.', {
    areas: ['chest'], also: ['triceps', 'shoulders'], pattern: 'push', gear: ['machines'], where: GYM, goals: MUSCLE, reps: 12, rest: 75, kg: true,
    how: ['Set the seat so the handles are at chest height.', 'Press forward until your arms are nearly straight.', 'Return slowly.'],
    alts: ['dumbbell_bench_press', 'bench_press', 'push_up'] }),
  ex('band_chest_press', 'Resistance Band Chest Press', 'A standing press against a band.', {
    areas: ['chest'], also: ['triceps', 'shoulders'], pattern: 'push', gear: ['resistance_bands'], goals: BASICS, reps: 12,
    how: ['Anchor the band behind you at chest height.', 'Press both hands forward.', 'Return with control.'],
    alts: ['push_up', 'incline_push_up'] }),
  ex('dumbbell_fly', 'Dumbbell Fly', 'A wide arc that stretches and works the chest.', {
    areas: ['chest'], also: ['shoulders'], pattern: 'push', level: 'intermediate', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, kg: true,
    how: ['Lie back, dumbbells above your chest, elbows slightly bent.', 'Open your arms wide until you feel a stretch.', 'Bring them back together.'],
    alts: ['dumbbell_bench_press', 'push_up'] }),

  // ── Back ────────────────────────────────────────────────────────────────
  ex('dumbbell_row', 'One-arm Dumbbell Row', 'A pull for the back, one side at a time.', {
    areas: ['back'], also: ['biceps'], pattern: 'pull', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, kg: true,
    how: ['One hand and knee on a bench, back flat.', 'Pull the dumbbell to your hip.', 'Lower it slowly.'],
    alts: ['seated_cable_row', 'band_row', 'barbell_row'] }),
  ex('lat_pulldown', 'Lat Pulldown', 'A machine pull for the upper back.', {
    areas: ['back'], also: ['biceps'], pattern: 'pull', gear: ['machines'], where: GYM, goals: MUSCLE, reps: 12, rest: 75, kg: true,
    how: ['Grip the bar a little wider than your shoulders.', 'Pull it to your upper chest, squeezing your shoulder blades.', 'Let it rise under control.'],
    alts: ['pull_up', 'band_row', 'dumbbell_row'] }),
  ex('seated_cable_row', 'Seated Cable Row', 'A seated pull for the middle of the back.', {
    areas: ['back'], also: ['biceps'], pattern: 'pull', gear: ['machines'], where: GYM, goals: MUSCLE, reps: 12, rest: 75, kg: true,
    how: ['Sit tall with your knees slightly bent.', 'Pull the handle to your stomach.', 'Reach forward again without rounding your back.'],
    alts: ['dumbbell_row', 'band_row'] }),
  ex('band_row', 'Resistance Band Row', 'A seated or standing pull with a band.', {
    areas: ['back'], also: ['biceps'], pattern: 'pull', gear: ['resistance_bands'], goals: BASICS, reps: 12,
    how: ['Anchor the band at chest height.', 'Pull your elbows back past your ribs.', 'Return slowly, keeping the band tight.'],
    alts: ['dumbbell_row', 'superman'] }),
  ex('barbell_row', 'Bent-over Barbell Row', 'A heavy pull for the whole back.', {
    areas: ['back'], also: ['biceps', 'lower_back'], pattern: 'pull', level: 'intermediate', gear: ['free_weights'], where: GYM, goals: MUSCLE, rest: 90, kg: true,
    how: ['Hinge forward with a flat back, bar hanging.', 'Pull the bar to your lower ribs.', 'Lower it without standing up.'],
    alts: ['dumbbell_row', 'seated_cable_row'] }),
  ex('pull_up', 'Pull-up', 'Pull your body up to a bar.', {
    areas: ['back'], also: ['biceps', 'abs'], pattern: 'pull', level: 'advanced', where: ['gym', 'outdoor'], goals: MUSCLE, reps: 6, rest: 90,
    how: ['Hang from the bar, hands a little wider than your shoulders.', 'Pull until your chin passes the bar.', 'Lower all the way down.'],
    alts: ['lat_pulldown', 'band_row'] }),
  ex('superman', 'Superman', 'A floor lift for the back of the body.', {
    areas: ['lower_back', 'back'], also: ['glutes'], pattern: 'hinge', goals: [...BASICS, 'improve_flexibility'], reps: 12, rest: 45,
    how: ['Lie face down, arms stretched ahead.', 'Lift your arms, chest and legs a little off the floor.', 'Hold a moment, then lower.'],
    alts: ['bird_dog'] }),

  // ── Shoulders ───────────────────────────────────────────────────────────
  ex('dumbbell_shoulder_press', 'Dumbbell Shoulder Press', 'An overhead press, seated or standing.', {
    areas: ['shoulders'], also: ['triceps'], pattern: 'push', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, rest: 75, kg: true,
    how: ['Dumbbells at shoulder height, palms forward.', 'Press overhead without arching your lower back.', 'Lower to your shoulders.'],
    alts: ['overhead_press', 'pike_push_up'] }),
  ex('overhead_press', 'Barbell Overhead Press', 'A standing barbell press.', {
    areas: ['shoulders'], also: ['triceps', 'abs'], pattern: 'push', level: 'intermediate', gear: ['free_weights'], where: GYM, goals: MUSCLE, reps: 8, rest: 90, kg: true,
    how: ['Bar on your upper chest, hands just outside your shoulders.', 'Press straight up, moving your head through at the top.', 'Lower with control.'],
    alts: ['dumbbell_shoulder_press', 'pike_push_up'] }),
  ex('lateral_raise', 'Lateral Raise', 'A light lift out to the sides.', {
    areas: ['shoulders'], pattern: 'push', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, rest: 45, kg: true,
    how: ['Dumbbells at your sides, elbows slightly bent.', 'Raise your arms to shoulder height.', 'Lower slowly.'],
    alts: ['band_pull_apart', 'pike_push_up'] }),
  ex('pike_push_up', 'Pike Push-up', 'A push-up with the hips high, for the shoulders.', {
    areas: ['shoulders'], also: ['triceps'], pattern: 'push', level: 'intermediate', goals: BASICS, reps: 8,
    how: ['From a push-up, walk your feet in and lift your hips.', 'Lower the top of your head toward the floor.', 'Press back up.'],
    alts: ['dumbbell_shoulder_press', 'band_pull_apart'] }),
  ex('band_pull_apart', 'Band Pull-apart', 'A simple move for the back of the shoulders.', {
    areas: ['shoulders'], also: ['back'], pattern: 'pull', gear: ['resistance_bands'], goals: [...BASICS, 'improve_flexibility'], reps: 15, rest: 45,
    how: ['Hold the band in front of you at shoulder height.', 'Pull your hands apart until the band touches your chest.', 'Return slowly.'],
    alts: ['lateral_raise'] }),
  ex('shoulder_tap', 'Plank Shoulder Tap', 'Tap each shoulder in turn from a push-up position.', {
    areas: ['shoulders'], also: ['abs', 'chest'], pattern: 'core', goals: BASICS, reps: 16, rest: 45,
    how: ['Start at the top of a push-up, feet apart.', 'Lift one hand to tap the opposite shoulder.', 'Change hands, keeping your hips still.'],
    alts: ['pike_push_up', 'band_pull_apart'] }),

  // ── Arms ────────────────────────────────────────────────────────────────
  ex('dumbbell_curl', 'Dumbbell Curl', 'The basic curl for the biceps.', {
    areas: ['biceps'], pattern: 'pull', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, rest: 45, kg: true,
    how: ['Stand tall, dumbbells at your sides.', 'Curl them up, keeping your elbows by your ribs.', 'Lower slowly.'],
    alts: ['hammer_curl', 'band_curl', 'barbell_curl'] }),
  ex('hammer_curl', 'Hammer Curl', 'A curl with the palms facing each other.', {
    areas: ['biceps'], pattern: 'pull', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, rest: 45, kg: true,
    how: ['Hold the dumbbells like hammers.', 'Curl up without swinging.', 'Lower slowly.'],
    alts: ['dumbbell_curl', 'band_curl'] }),
  ex('barbell_curl', 'Barbell Curl', 'A two-handed curl with a bar.', {
    areas: ['biceps'], pattern: 'pull', gear: ['free_weights'], where: GYM, goals: MUSCLE, rest: 60, kg: true,
    how: ['Grip the bar at shoulder width.', 'Curl it to your chest, elbows still.', 'Lower all the way.'],
    alts: ['dumbbell_curl', 'band_curl'] }),
  ex('band_curl', 'Resistance Band Curl', 'A curl standing on a band.', {
    areas: ['biceps'], pattern: 'pull', gear: ['resistance_bands'], goals: BASICS, reps: 15, rest: 45,
    how: ['Stand on the band, an end in each hand.', 'Curl your hands to your shoulders.', 'Lower slowly.'],
    alts: ['dumbbell_curl'] }),
  ex('bag_curl', 'Bag Curl', 'A curl with a loaded bag or water container when there are no weights.', {
    areas: ['biceps'], pattern: 'pull', where: ['home', 'outdoor'], goals: BASICS, reps: 12, rest: 45,
    how: ['Hold a bag or full water container in one hand.', 'Curl it to your shoulder, elbow by your ribs.', 'Lower slowly; change sides after the set.'],
    alts: ['band_curl', 'dumbbell_curl'] }),
  ex('bench_dip', 'Bench Dip', 'A dip with your hands on a bench or chair.', {
    areas: ['triceps'], also: ['shoulders', 'chest'], pattern: 'push', goals: BASICS, reps: 12,
    how: ['Hands on the edge behind you, legs out in front.', 'Bend your elbows to lower your hips.', 'Press back up.'],
    alts: ['close_grip_push_up', 'overhead_triceps_extension', 'triceps_pushdown'] }),
  ex('close_grip_push_up', 'Close-grip Push-up', 'A push-up with the hands close, for the triceps.', {
    areas: ['triceps'], also: ['chest', 'shoulders'], pattern: 'push', level: 'intermediate', goals: BASICS, reps: 8,
    how: ['Hands under your chest, close together.', 'Lower with your elbows brushing your sides.', 'Press back up.'],
    alts: ['bench_dip', 'overhead_triceps_extension'] }),
  ex('overhead_triceps_extension', 'Overhead Triceps Extension', 'One dumbbell lowered behind the head.', {
    areas: ['triceps'], pattern: 'push', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, rest: 45, kg: true,
    how: ['Hold one dumbbell overhead with both hands.', 'Lower it behind your head, elbows pointing up.', 'Straighten your arms.'],
    alts: ['bench_dip', 'triceps_pushdown'] }),
  ex('triceps_pushdown', 'Triceps Pushdown', 'A cable press-down for the triceps.', {
    areas: ['triceps'], pattern: 'push', gear: ['machines'], where: GYM, goals: MUSCLE, reps: 12, rest: 45, kg: true,
    how: ['Elbows by your sides, hands on the bar or rope.', 'Push down until your arms are straight.', 'Let it rise to chest height.'],
    alts: ['overhead_triceps_extension', 'bench_dip'] }),

  // ── Legs ────────────────────────────────────────────────────────────────
  ex('bodyweight_squat', 'Bodyweight Squat', 'The basic squat for the legs and glutes.', {
    areas: ['quadriceps', 'glutes'], also: ['hamstrings', 'abs'], pattern: 'squat', goals: BASICS, reps: 15,
    how: ['Feet shoulder-width apart, chest up.', 'Sit back and down until your thighs are level.', 'Stand up through your heels.'],
    alts: ['goblet_squat', 'step_up'] }),
  ex('goblet_squat', 'Goblet Squat', 'A squat holding one dumbbell at the chest.', {
    areas: ['quadriceps', 'glutes'], also: ['hamstrings', 'abs'], pattern: 'squat', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, rest: 75, kg: true,
    how: ['Hold a dumbbell upright against your chest.', 'Squat down between your knees.', 'Stand tall at the top.'],
    alts: ['bodyweight_squat', 'leg_press', 'back_squat'] }),
  ex('back_squat', 'Barbell Back Squat', 'The barbell squat.', {
    areas: ['quadriceps', 'glutes'], also: ['hamstrings', 'lower_back'], pattern: 'squat', level: 'intermediate', gear: ['free_weights'], where: GYM, goals: MUSCLE, reps: 8, rest: 120, kg: true,
    how: ['Bar across your upper back, feet shoulder-width apart.', 'Sit down and back, knees following your toes.', 'Drive up to standing.'],
    alts: ['goblet_squat', 'leg_press', 'bodyweight_squat'] }),
  ex('leg_press', 'Leg Press', 'A machine press for the legs.', {
    areas: ['quadriceps', 'glutes'], also: ['hamstrings'], pattern: 'squat', gear: ['machines'], where: GYM, goals: MUSCLE, reps: 12, rest: 90, kg: true,
    how: ['Feet shoulder-width on the platform.', 'Lower it until your knees are bent to a right angle.', 'Press away without locking your knees.'],
    alts: ['goblet_squat', 'bodyweight_squat'] }),
  ex('walking_lunge', 'Walking Lunge', 'Long steps that work each leg in turn.', {
    areas: ['quadriceps', 'glutes'], also: ['hamstrings'], pattern: 'lunge', goals: BASICS, reps: 12,
    how: ['Step forward and lower your back knee toward the floor.', 'Push through your front heel to step into the next one.', 'Keep your chest tall.'],
    alts: ['split_squat', 'step_up'] }),
  ex('split_squat', 'Split Squat', 'A lunge done on the spot.', {
    areas: ['quadriceps', 'glutes'], also: ['hamstrings'], pattern: 'lunge', level: 'intermediate', goals: BASICS, reps: 10,
    how: ['Stand with one foot well ahead of the other.', 'Lower straight down until your back knee nearly touches.', 'Stand up; change sides after the set.'],
    alts: ['walking_lunge', 'step_up'] }),
  ex('step_up', 'Step-up', 'Step onto a bench or sturdy step.', {
    areas: ['quadriceps', 'glutes'], also: ['calves'], pattern: 'lunge', goals: [...BASICS, 'improve_endurance'], reps: 12,
    how: ['One foot flat on the step.', 'Stand up onto it without pushing off the back foot.', 'Step down slowly; change sides after the set.'],
    alts: ['walking_lunge', 'bodyweight_squat'] }),
  ex('glute_bridge', 'Glute Bridge', 'A floor lift for the glutes and hamstrings.', {
    areas: ['glutes'], also: ['hamstrings', 'lower_back'], pattern: 'hinge', goals: BASICS, reps: 15, rest: 45,
    how: ['Lie on your back, knees bent, feet flat.', 'Lift your hips until your body is straight from knee to shoulder.', 'Squeeze, then lower.'],
    alts: ['donkey_kick', 'hip_thrust'] }),
  ex('hip_thrust', 'Barbell Hip Thrust', 'A loaded bridge with the shoulders on a bench.', {
    areas: ['glutes'], also: ['hamstrings'], pattern: 'hinge', level: 'intermediate', gear: ['free_weights'], where: GYM, goals: MUSCLE, rest: 90, kg: true,
    how: ['Shoulders on a bench, bar across your hips.', 'Drive your hips up until your body is level.', 'Lower with control.'],
    alts: ['glute_bridge', 'donkey_kick'] }),
  ex('donkey_kick', 'Donkey Kick', 'A kick-back on hands and knees.', {
    areas: ['glutes'], also: ['hamstrings'], pattern: 'hinge', goals: BASICS, reps: 15, rest: 45,
    how: ['On hands and knees, back flat.', 'Lift one bent leg until your thigh is level with your back.', 'Lower; change sides after the set.'],
    alts: ['glute_bridge'] }),
  ex('romanian_deadlift', 'Romanian Deadlift', 'A hip hinge with a barbell for the hamstrings.', {
    areas: ['hamstrings'], also: ['glutes', 'lower_back'], pattern: 'hinge', level: 'intermediate', gear: ['free_weights'], where: GYM, goals: MUSCLE, rest: 90, kg: true,
    how: ['Stand tall with the bar at your thighs.', 'Push your hips back, sliding the bar down your legs, back flat.', 'Stand up by driving your hips forward.'],
    alts: ['dumbbell_rdl', 'leg_curl', 'good_morning'] }),
  ex('dumbbell_rdl', 'Dumbbell Romanian Deadlift', 'The same hinge with dumbbells.', {
    areas: ['hamstrings'], also: ['glutes', 'lower_back'], pattern: 'hinge', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 12, rest: 75, kg: true,
    how: ['Dumbbells in front of your thighs.', 'Push your hips back with a flat back until you feel your hamstrings.', 'Stand tall again.'],
    alts: ['good_morning', 'romanian_deadlift', 'leg_curl'] }),
  ex('leg_curl', 'Leg Curl', 'A machine curl for the hamstrings.', {
    areas: ['hamstrings'], pattern: 'hinge', gear: ['machines'], where: GYM, goals: MUSCLE, reps: 12, kg: true,
    how: ['Set the pad just above your heels.', 'Curl your heels toward you.', 'Return slowly.'],
    alts: ['dumbbell_rdl', 'good_morning'] }),
  ex('good_morning', 'Bodyweight Good Morning', 'A bow from the hips with no load.', {
    areas: ['hamstrings'], also: ['glutes', 'lower_back'], pattern: 'hinge', goals: [...BASICS, 'improve_flexibility'], reps: 15, rest: 45,
    how: ['Hands behind your head, knees soft.', 'Push your hips back and bow forward with a flat back.', 'Stand tall again.'],
    alts: ['glute_bridge', 'dumbbell_rdl'] }),
  ex('calf_raise', 'Calf Raise', 'Rise onto your toes.', {
    areas: ['calves'], pattern: 'squat', goals: BASICS, reps: 15, rest: 45,
    how: ['Stand tall, holding something for balance if needed.', 'Rise onto the balls of your feet.', 'Lower slowly.'],
    alts: ['dumbbell_calf_raise'] }),
  ex('dumbbell_calf_raise', 'Dumbbell Calf Raise', 'A calf raise holding dumbbells.', {
    areas: ['calves'], pattern: 'squat', gear: ['dumbbells'], where: INDOORS, goals: MUSCLE, reps: 15, rest: 45, kg: true,
    how: ['Dumbbells at your sides.', 'Rise onto the balls of your feet.', 'Lower slowly.'],
    alts: ['calf_raise'] }),

  // ── Core ────────────────────────────────────────────────────────────────
  ex('plank', 'Plank', 'A hold that steadies the whole trunk.', {
    areas: ['abs'], also: ['obliques', 'lower_back', 'shoulders'], pattern: 'core', goals: FITNESS_GOAL_IDS, secs: 30, rest: 45,
    how: ['Forearms on the floor, elbows under shoulders.', 'Hold a straight line from head to heels.', 'Breathe steadily; stop when your hips drop.'],
    alts: ['dead_bug', 'crunch'] }),
  ex('dead_bug', 'Dead Bug', 'A slow core move lying on your back.', {
    areas: ['abs'], also: ['lower_back'], pattern: 'core', goals: FITNESS_GOAL_IDS, reps: 12, rest: 45,
    how: ['On your back, arms up, knees bent above your hips.', 'Lower one arm and the opposite leg toward the floor.', 'Return and change sides, lower back pressed down.'],
    alts: ['plank', 'crunch'] }),
  ex('crunch', 'Crunch', 'A short curl of the trunk.', {
    areas: ['abs'], pattern: 'core', goals: BASICS, reps: 15, rest: 45,
    how: ['On your back, knees bent, hands by your temples.', 'Curl your shoulders off the floor.', 'Lower slowly.'],
    alts: ['dead_bug', 'plank'] }),
  ex('leg_raise', 'Lying Leg Raise', 'Raise straight legs from the floor.', {
    areas: ['abs'], pattern: 'core', level: 'intermediate', goals: BASICS, reps: 10, rest: 45,
    how: ['On your back, legs straight, hands by your hips.', 'Raise your legs until they point up.', 'Lower them slowly without arching your back.'],
    alts: ['dead_bug', 'crunch'] }),
  ex('side_plank', 'Side Plank', 'A hold on one forearm for the sides of the trunk.', {
    areas: ['obliques'], also: ['abs', 'shoulders'], pattern: 'core', goals: FITNESS_GOAL_IDS, sets: 2, secs: 20, rest: 30,
    how: ['On your side, elbow under your shoulder.', 'Lift your hips so your body is straight.', 'Hold; change sides.'],
    alts: ['russian_twist', 'bicycle_crunch'] }),
  ex('russian_twist', 'Russian Twist', 'A seated turn from side to side.', {
    areas: ['obliques'], also: ['abs'], pattern: 'rotation', goals: BASICS, reps: 20, rest: 45,
    how: ['Sit with knees bent, leaning back a little.', 'Turn your shoulders to one side, then the other.', 'Keep your chest lifted.'],
    alts: ['bicycle_crunch', 'side_plank'] }),
  ex('bicycle_crunch', 'Bicycle Crunch', 'Elbow to opposite knee, in turn.', {
    areas: ['obliques'], also: ['abs'], pattern: 'rotation', goals: BASICS, reps: 20, rest: 45,
    how: ['On your back, hands by your temples, legs lifted.', 'Bring one elbow toward the opposite knee as the other leg straightens.', 'Change sides in a steady rhythm.'],
    alts: ['russian_twist', 'side_plank'] }),
  ex('bird_dog', 'Bird Dog', 'A balance move for the lower back and core.', {
    areas: ['lower_back'], also: ['abs', 'glutes'], pattern: 'core', goals: FITNESS_GOAL_IDS, reps: 10, rest: 30,
    how: ['On hands and knees, back flat.', 'Reach one arm forward and the opposite leg back.', 'Hold a moment, then change sides.'],
    alts: ['superman', 'dead_bug'] }),

  // ── Cardio and conditioning ─────────────────────────────────────────────
  ex('jumping_jacks', 'Jumping Jacks', 'A simple whole-body warm-up and cardio move.', {
    cat: 'cardio', areas: ['cardio'], also: ['full_body'], pattern: 'locomotion', goals: CARDIO, secs: 45, rest: 30,
    how: ['Jump your feet apart as your arms go overhead.', 'Jump back to the start.', 'Keep a steady rhythm.'],
    alts: ['high_knees', 'shadow_boxing'] }),
  ex('high_knees', 'High Knees', 'Running on the spot with the knees high.', {
    cat: 'cardio', areas: ['cardio'], also: ['quadriceps', 'abs'], pattern: 'locomotion', goals: CARDIO, secs: 30, rest: 30,
    how: ['Run on the spot.', 'Lift each knee to hip height.', 'Stay light on your feet.'],
    alts: ['jumping_jacks', 'shadow_boxing'] }),
  ex('shadow_boxing', 'Shadow Boxing', 'Punches in the air, moving your feet.', {
    cat: 'cardio', areas: ['cardio'], also: ['shoulders', 'abs'], pattern: 'rotation', goals: [...CARDIO, 'learn_new_skill', 'stress_relief'], secs: 60, rest: 30,
    how: ['Stand side-on, hands up by your chin.', 'Throw straight punches, turning your hips.', 'Keep moving your feet.'],
    alts: ['jumping_jacks', 'high_knees'] }),
  ex('skipping', 'Skipping Rope', 'Jumping rope at a steady pace.', {
    cat: 'cardio', areas: ['cardio'], also: ['calves'], pattern: 'locomotion', gear: ['other'], goals: CARDIO, secs: 60, rest: 45,
    how: ['Elbows close, turn the rope with your wrists.', 'Small jumps, just clearing the rope.', 'Land softly.'],
    alts: ['jumping_jacks', 'high_knees'] }),
  ex('brisk_walk', 'Brisk Walk', 'A fast walk that raises your breathing.', {
    cat: 'cardio', areas: ['cardio'], pattern: 'locomotion', where: ['outdoor'], goals: [...CARDIO, 'stress_relief'], sets: 1, secs: 900, rest: 0,
    how: ['Walk fast enough that talking takes a little effort.', 'Swing your arms.', 'Keep the pace steady to the end.'],
    alts: ['jog_intervals', 'stair_climb'] }),
  ex('jog_intervals', 'Jog and Walk Intervals', 'Jog a minute, walk a minute.', {
    cat: 'cardio', areas: ['cardio'], also: ['quadriceps', 'calves'], pattern: 'locomotion', where: ['outdoor'], goals: CARDIO, sets: 6, secs: 60, rest: 60,
    how: ['Jog at an easy pace for the set.', 'Walk during the rest.', 'Keep every jog the same pace.'],
    alts: ['brisk_walk', 'high_knees'] }),
  ex('stair_climb', 'Stair Climb', 'Walk up and down a flight of stairs.', {
    cat: 'cardio', areas: ['cardio'], also: ['quadriceps', 'glutes', 'calves'], pattern: 'locomotion', where: ['home', 'outdoor'], goals: CARDIO, secs: 120, rest: 60,
    how: ['Climb at a steady pace, whole foot on each step.', 'Walk down carefully.', 'Repeat until the time is up.'],
    alts: ['step_up', 'brisk_walk'] }),
  ex('treadmill_run', 'Treadmill Run', 'A steady run or fast walk on the treadmill.', {
    cat: 'cardio', areas: ['cardio'], pattern: 'locomotion', gear: ['machines'], where: GYM, goals: CARDIO, sets: 1, secs: 600, rest: 0,
    how: ['Start at a walk and build to a pace you can hold.', 'Stay tall, looking ahead.', 'Slow to a walk for the last minute.'],
    alts: ['stationary_bike', 'high_knees'] }),
  ex('stationary_bike', 'Stationary Bike', 'Steady cycling on a gym bike.', {
    cat: 'cardio', areas: ['cardio'], also: ['quadriceps'], pattern: 'locomotion', gear: ['machines'], where: GYM, goals: CARDIO, sets: 1, secs: 600, rest: 0,
    how: ['Set the seat so your knee is slightly bent at the bottom.', 'Pedal at a pace that raises your breathing.', 'Ease off for the last minute.'],
    alts: ['treadmill_run', 'jumping_jacks'] }),
  ex('burpee', 'Burpee', 'Down to the floor and up into a jump.', {
    cat: 'hiit', areas: ['full_body', 'cardio'], also: ['chest', 'quadriceps'], pattern: 'locomotion', level: 'intermediate', goals: CARDIO, reps: 10, rest: 45,
    how: ['Squat, hands to the floor, jump your feet back.', 'Chest to the floor, then jump your feet in.', 'Jump up with your arms overhead.'],
    alts: ['mountain_climber', 'jump_squat'] }),
  ex('mountain_climber', 'Mountain Climber', 'Running your knees in from a push-up position.', {
    cat: 'hiit', areas: ['cardio', 'abs'], also: ['shoulders'], pattern: 'locomotion', goals: CARDIO, secs: 30, rest: 30,
    how: ['Start at the top of a push-up.', 'Drive one knee to your chest, then the other.', 'Keep your hips level.'],
    alts: ['high_knees', 'burpee'] }),
  ex('jump_squat', 'Jump Squat', 'A squat that ends in a jump.', {
    cat: 'hiit', areas: ['quadriceps', 'cardio'], also: ['glutes', 'calves'], pattern: 'squat', level: 'intermediate', goals: CARDIO, reps: 12, rest: 45,
    how: ['Squat down.', 'Jump straight up.', 'Land softly and go straight into the next one.'],
    alts: ['bodyweight_squat', 'high_knees'] }),

  // ── Whole body ──────────────────────────────────────────────────────────
  ex('bear_crawl', 'Bear Crawl', 'Crawling on hands and feet, knees off the floor.', {
    cat: 'functional', areas: ['full_body'], also: ['shoulders', 'abs', 'quadriceps'], pattern: 'locomotion', goals: [...BASICS, 'improve_endurance'], secs: 30, rest: 45,
    how: ['On hands and feet, knees just off the floor.', 'Move opposite hand and foot together.', 'Keep your back flat.'],
    alts: ['mountain_climber'] }),
  ex('farmer_carry', 'Farmer Carry', 'Walk while holding a weight in each hand.', {
    cat: 'functional', areas: ['full_body'], also: ['shoulders', 'abs'], pattern: 'carry', gear: ['dumbbells'], where: INDOORS, goals: BASICS, secs: 40, kg: true,
    how: ['Pick up a dumbbell in each hand and stand tall.', 'Walk with short steps, shoulders back.', 'Set them down with a flat back.'],
    alts: ['bear_crawl'] }),
  ex('dumbbell_thruster', 'Dumbbell Thruster', 'A squat straight into an overhead press.', {
    cat: 'functional', areas: ['full_body'], also: ['quadriceps', 'shoulders', 'glutes'], pattern: 'squat', level: 'intermediate', gear: ['dumbbells'], where: INDOORS, goals: [...BASICS, 'improve_endurance'], rest: 75, kg: true,
    how: ['Dumbbells at your shoulders.', 'Squat down.', 'Stand up and press them overhead in one movement.'],
    alts: ['burpee', 'bear_crawl'] }),

  // ── Mobility and stretching ─────────────────────────────────────────────
  ex('cat_cow', 'Cat-Cow', 'Gently arching and rounding the back.', {
    cat: 'mobility', areas: ['mobility'], also: ['lower_back'], pattern: 'stretch', goals: CALM, sets: 2, reps: 10, rest: 15,
    how: ['On hands and knees.', 'Round your back up, then let it dip as you look ahead.', 'Move slowly with your breathing.'],
    alts: ['childs_pose', 'thread_the_needle'] }),
  ex('worlds_greatest_stretch', 'Lunge with Rotation', 'A deep lunge with a turn of the chest.', {
    cat: 'mobility', areas: ['mobility'], also: ['glutes', 'hamstrings', 'back'], pattern: 'stretch', level: 'intermediate', goals: CALM, sets: 2, reps: 6, rest: 15,
    how: ['Step into a long lunge, both hands on the floor.', 'Turn your chest and reach one arm to the ceiling.', 'Return; change sides after the set.'],
    alts: ['hip_flexor_stretch', 'thread_the_needle'] }),
  ex('thread_the_needle', 'Thread the Needle', 'A turning stretch for the upper back and shoulders.', {
    cat: 'mobility', areas: ['mobility'], also: ['shoulders', 'back'], pattern: 'stretch', goals: CALM, sets: 2, reps: 8, rest: 15,
    how: ['On hands and knees.', 'Slide one arm under the other until your shoulder rests on the floor.', 'Return and reach it up; change sides after the set.'],
    alts: ['cat_cow', 'childs_pose'] }),
  ex('downward_dog', 'Downward Dog', 'An upside-down V that stretches the back of the body.', {
    cat: 'mobility', areas: ['mobility'], also: ['hamstrings', 'calves', 'shoulders'], pattern: 'stretch', goals: CALM, sets: 2, secs: 30, rest: 15,
    how: ['From hands and knees, lift your hips up and back.', 'Press your chest toward your thighs.', 'Ease your heels toward the floor.'],
    alts: ['hamstring_stretch', 'childs_pose'] }),
  ex('hip_flexor_stretch', 'Hip Flexor Stretch', 'A kneeling stretch for the front of the hips.', {
    cat: 'stretching', areas: ['mobility'], also: ['quadriceps'], pattern: 'stretch', goals: CALM, sets: 2, secs: 30, rest: 15,
    how: ['Kneel on one knee with the other foot forward.', 'Ease your hips forward until you feel the stretch.', 'Hold, then change sides.'],
    alts: ['worlds_greatest_stretch', 'childs_pose'] }),
  ex('hamstring_stretch', 'Seated Hamstring Stretch', 'A seated reach toward the toes.', {
    cat: 'stretching', areas: ['mobility'], also: ['hamstrings'], pattern: 'stretch', goals: CALM, sets: 2, secs: 30, rest: 15,
    how: ['Sit with one leg straight, the other foot against your thigh.', 'Reach toward your toes with a long back.', 'Hold, then change sides.'],
    alts: ['downward_dog'] }),
  ex('childs_pose', "Child's Pose", 'A resting stretch for the back and hips.', {
    cat: 'stretching', areas: ['mobility'], also: ['lower_back'], pattern: 'stretch', goals: CALM, sets: 2, secs: 40, rest: 15,
    how: ['Kneel and sit back on your heels.', 'Fold forward, arms stretched ahead, forehead down.', 'Breathe slowly.'],
    alts: ['cat_cow', 'downward_dog'] }),
  ex('deep_breathing', 'Slow Breathing', 'Slow, even breaths to settle down.', {
    cat: 'mobility', areas: ['mobility'], pattern: 'stretch', goals: ['stress_relief', 'improve_flexibility', 'stay_fit'], sets: 1, secs: 120, rest: 0,
    how: ['Sit or lie comfortably, one hand on your stomach.', 'Breathe in through your nose for four counts.', 'Breathe out slowly for six counts.'],
    alts: ['childs_pose'] }),
];

const within = (list, allowed) => Array.isArray(list) && list.every(x => allowed.includes(x));
const positive = n => Number.isInteger(n) && n > 0;

/** Why an entry is not a valid exercise, or null when it is. */
export function exerciseProblem(e, ids = new Set(EXERCISES.map(x => x.id))) {
  if (!e || typeof e !== 'object') return 'not_an_object';
  if (typeof e.id !== 'string' || !/^ex_[a-z0-9_]+$/.test(e.id)) return 'id';
  if (typeof e.name !== 'string' || !e.name.trim() || e.name.length > 80) return 'name';
  if (!EXERCISE_CATEGORIES.includes(e.category)) return 'category';
  if (!within(e.targetAreas, TARGET_AREAS) || !e.targetAreas.length) return 'targetAreas';
  if (!within(e.secondaryAreas ?? [], TARGET_AREAS)) return 'secondaryAreas';
  if (e.movementPattern != null && !MOVEMENT_PATTERNS.includes(e.movementPattern)) return 'movementPattern';
  if (!EXPERIENCE_LEVELS.includes(e.difficulty)) return 'difficulty';
  if (!within(e.equipment, EQUIPMENT) || !e.equipment.length) return 'equipment';
  if (!within(e.environment, EXERCISE_ENVIRONMENTS) || !e.environment.length) return 'environment';
  if (!within(e.suitableGoals, FITNESS_GOAL_IDS) || !e.suitableGoals.length) return 'suitableGoals';
  if (!positive(e.defaultSets)) return 'defaultSets';
  // Counted in reps or timed in seconds — one or the other.
  if (positive(e.defaultReps) === positive(e.defaultDuration)) return 'defaultReps_or_defaultDuration';
  if (!(Number.isInteger(e.restSeconds) && e.restSeconds >= 0)) return 'restSeconds';
  if (!Array.isArray(e.instructions) || !e.instructions.length || !e.instructions.every(s => typeof s === 'string' && s.trim())) return 'instructions';
  if (!Array.isArray(e.alternatives) || e.alternatives.includes(e.id) || !e.alternatives.every(a => ids.has(a))) return 'alternatives';
  if (typeof e.active !== 'boolean') return 'active';
  return null;
}

const BY_ID = new Map(EXERCISES.map(e => [e.id, e]));
export const exerciseById = id => BY_ID.get(id) ?? null;

const LEVEL = Object.fromEntries(EXPERIENCE_LEVELS.map((l, i) => [l, i]));

/**
 * Active exercises matching every filter given: target `area`, `category`,
 * `goal`, `environment` (a place; `any` or nothing means anywhere),
 * `equipment` (what the member has) and `experience` (nothing harder).
 */
export function listExercises({ area, category, goal, environment, equipment, experience } = {}, library = EXERCISES) {
  const have = equipment ? availableEquipment(equipment) : null;
  return library.filter(e => e.active
    && (!area || e.targetAreas.includes(area))
    && (!category || e.category === category)
    && (!goal || e.suitableGoals.includes(goal))
    && (!environment || environment === 'any' || e.environment.includes(environment))
    && (!have || e.equipment.every(x => have.has(x)))
    && (!experience || LEVEL[e.difficulty] <= LEVEL[experience]));
}

/** Active alternatives that keep the exercise's intent, limited to what the member can do. */
export function alternativesFor(id, filters = {}, library = EXERCISES) {
  const e = library.find(x => x.id === id);
  if (!e) return [];
  const usable = new Set(listExercises({ ...filters, area: undefined, category: undefined, goal: undefined }, library).map(x => x.id));
  return e.alternatives.map(a => library.find(x => x.id === a)).filter(a => a && usable.has(a.id));
}

/** An exercise in the member's language, falling back to English. */
export function localizedExercise(e, lang = 'en') {
  const t = e.i18n?.[lang];
  return t ? { ...e, name: t.name ?? e.name, description: t.description ?? e.description, instructions: t.instructions ?? e.instructions } : e;
}
