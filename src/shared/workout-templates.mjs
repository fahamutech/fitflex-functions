// Built-in FitFlex workout templates members can plan from until trainers
// can assign workouts. `reps` targets rep-based exercises; `duration`
// (seconds) targets timed ones. `tracksWeight` marks exercises where a
// load (kg) is worth recording.

export const WORKOUT_TEMPLATES = [
  {
    id: 'tpl_upper_strength',
    name: 'Upper Body Strength',
    description: 'Push and pull for chest, back, shoulders and arms.',
    activityType: 'strength',
    estimatedDuration: 45,
    exercises: [
      { exerciseName: 'Bench Press', muscleGroup: 'chest', sets: 3, reps: 10, tracksWeight: true, instructions: 'Lower the bar to mid-chest with control, press back up.' },
      { exerciseName: 'Lat Pulldown', muscleGroup: 'back', sets: 3, reps: 12, tracksWeight: true, instructions: 'Pull the bar to your upper chest, squeezing your shoulder blades.' },
      { exerciseName: 'Shoulder Press', muscleGroup: 'shoulders', sets: 3, reps: 10, tracksWeight: true, instructions: 'Press overhead without arching your lower back.' },
      { exerciseName: 'Seated Cable Row', muscleGroup: 'back', sets: 3, reps: 12, tracksWeight: true, instructions: 'Keep your chest tall and pull the handle to your stomach.' },
      { exerciseName: 'Bicep Curl', muscleGroup: 'arms', sets: 3, reps: 12, tracksWeight: true, instructions: 'Keep your elbows at your sides.' },
    ],
  },
  {
    id: 'tpl_lower_strength',
    name: 'Lower Body Strength',
    description: 'Squat, hinge and lunge for legs and glutes.',
    activityType: 'strength',
    estimatedDuration: 50,
    exercises: [
      { exerciseName: 'Back Squat', muscleGroup: 'legs', sets: 4, reps: 8, tracksWeight: true, instructions: 'Sit back and down, knees tracking over toes.' },
      { exerciseName: 'Romanian Deadlift', muscleGroup: 'hamstrings', sets: 3, reps: 10, tracksWeight: true, instructions: 'Hinge at the hips with a flat back; feel the stretch in your hamstrings.' },
      { exerciseName: 'Walking Lunge', muscleGroup: 'legs', sets: 3, reps: 12, tracksWeight: true, instructions: 'Long steps; back knee close to the floor.' },
      { exerciseName: 'Leg Press', muscleGroup: 'legs', sets: 3, reps: 12, tracksWeight: true, instructions: 'Lower until knees reach about 90 degrees.' },
      { exerciseName: 'Calf Raise', muscleGroup: 'calves', sets: 3, reps: 15, tracksWeight: true, instructions: 'Pause at the top of each rep.' },
    ],
  },
  {
    id: 'tpl_full_body_beginner',
    name: 'Full Body Beginner',
    description: 'A gentle full-body session to build the habit.',
    activityType: 'functional',
    estimatedDuration: 35,
    exercises: [
      { exerciseName: 'Goblet Squat', muscleGroup: 'legs', sets: 3, reps: 10, tracksWeight: true, instructions: 'Hold a dumbbell at your chest and squat to a comfortable depth.' },
      { exerciseName: 'Push-up', muscleGroup: 'chest', sets: 3, reps: 8, tracksWeight: false, instructions: 'Drop to your knees if you need to.' },
      { exerciseName: 'Dumbbell Row', muscleGroup: 'back', sets: 3, reps: 10, tracksWeight: true, instructions: 'Support yourself on a bench and row towards your hip.' },
      { exerciseName: 'Glute Bridge', muscleGroup: 'glutes', sets: 3, reps: 12, tracksWeight: false, instructions: 'Drive through your heels and squeeze at the top.' },
      { exerciseName: 'Plank', muscleGroup: 'core', sets: 3, duration: 30, tracksWeight: false, instructions: 'Straight line from head to heels.' },
    ],
  },
  {
    id: 'tpl_hiit_express',
    name: 'HIIT Express',
    description: 'Four fast intervals, repeated. Rest 20 seconds between efforts.',
    activityType: 'hiit',
    estimatedDuration: 20,
    exercises: [
      { exerciseName: 'Jump Squat', muscleGroup: 'legs', sets: 4, duration: 40, tracksWeight: false, instructions: 'Land softly and go straight into the next rep.' },
      { exerciseName: 'Burpee', muscleGroup: 'full_body', sets: 4, duration: 40, tracksWeight: false, instructions: 'Step back instead of jumping to make it easier.' },
      { exerciseName: 'Mountain Climber', muscleGroup: 'core', sets: 4, duration: 40, tracksWeight: false, instructions: 'Hips level, drive the knees.' },
      { exerciseName: 'High Knees', muscleGroup: 'full_body', sets: 4, duration: 40, tracksWeight: false, instructions: 'Stay on the balls of your feet.' },
    ],
  },
  {
    id: 'tpl_core_mobility',
    name: 'Core & Mobility',
    description: 'Core control and stretches for recovery days.',
    activityType: 'mobility',
    estimatedDuration: 25,
    exercises: [
      { exerciseName: 'Dead Bug', muscleGroup: 'core', sets: 3, reps: 10, tracksWeight: false, instructions: 'Press your lower back into the floor throughout.' },
      { exerciseName: 'Side Plank', muscleGroup: 'core', sets: 3, duration: 30, tracksWeight: false, instructions: 'Each side. Keep hips lifted.' },
      { exerciseName: 'Bird Dog', muscleGroup: 'core', sets: 3, reps: 10, tracksWeight: false, instructions: 'Reach long through opposite arm and leg.' },
      { exerciseName: 'Cat-Cow', muscleGroup: 'back', sets: 2, reps: 10, tracksWeight: false, instructions: 'Move slowly with your breath.' },
      { exerciseName: 'Hip Flexor Stretch', muscleGroup: 'hips', sets: 2, duration: 45, tracksWeight: false, instructions: 'Each side. Tuck your pelvis to deepen the stretch.' },
    ],
  },
];
